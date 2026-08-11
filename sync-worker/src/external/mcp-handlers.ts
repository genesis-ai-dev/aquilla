// MCP tools/call dispatch (AQU-533 §4). Each tool is either:
//   - a thin DELEGATION to an existing Wave-1 external route handler
//     (search/read/history -> read-routes.ts; prepare/get/commit/discard ->
//     changesets-route.ts) via an in-process synthetic Request carrying the same
//     bearer credential — no read/write logic is reimplemented here; or
//   - a small DIRECT read (capabilities/identity/list/get project) built from the
//     validated credential + the shared role/scope helpers.
//
// Tool errors are returned as MCP results with isError: true and a text body of
// { error: { code, message } } using the SAME stable codes as the REST surface,
// so agents branch identically across adapters.

import { ExternalError } from './errors'
import type { ExternalErrorCode } from './errors'
import { ROLE } from '../events/role-policy'
import { assertCredentialScope } from './token-bridge'
import { loadChangeset } from './store'
import { approvalUrlFor, CHANGESET_TTL_MS } from './prepare'
import { PLAN_IMPORT_MAX_CELLS } from './commands'
import { MAX_ARTIFACT_BYTES } from './artifacts-route'
import { handleExternalReadRequest } from './read-routes'
import { handleExternalChangesetsRequest } from './changesets-route'
import { listProjectsForCredential } from './projects-list'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import type { ExternalEnv } from './types'

/** MCP tools/call result envelope. */
export interface McpToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

/** The fixed external error-code set, published by get_capabilities. Mirrors
 *  ExternalErrorCode in errors.ts (kept as a runtime array — a type is erased). */
const ERROR_CODES: ExternalErrorCode[] = [
  'permission_denied',
  'scope_denied',
  'plan_stale',
  'confirmation_required',
  'validation_failed',
  'conflict',
  'job_failed',
  'rate_limited',
  'not_found',
]

function ok(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function fail(code: ExternalErrorCode, message: string, extra?: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...(extra ?? {}) } }) }],
    isError: true,
  }
}

/** Serialize a non-ok delegated Response (already an errors.ts envelope) as a
 *  tool error, preserving its stable code. */
async function delegatedError(res: Response): Promise<McpToolResult> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const err = (body as { error?: { code?: string; message?: string; details?: unknown } })?.error
  const code = (err?.code as ExternalErrorCode) ?? 'job_failed'
  const message = err?.message ?? `upstream error (status ${res.status})`
  return fail(code, message, err?.details !== undefined ? { details: err.details } : undefined)
}

// ── argument helpers ─────────────────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Marks a synthetic in-process Request as MCP-originated so commit.ts stamps
 *  `channel: 'mcp'` into the provenance envelope (§2) instead of the REST default. */
const MCP_CHANNEL_HEADER: Record<string, string> = { 'x-aquilla-channel': 'mcp' }

const EXTERNAL_BASE = 'https://internal/api/v1/external/projects'

// ── direct reads ─────────────────────────────────────────────────────────────

function getCapabilities(cred: ApiCredentialContext): McpToolResult {
  return ok({
    apiVersion: 'v1',
    credentialMode: cred.mode,
    // The numbered golden path, so a weak agent doesn't have to reconstruct
    // the workflow from per-tool descriptions.
    quickstart: [
      '1. get_identity_and_scope — confirm who you are, your mode (ask|act), and your org/project scope.',
      '2. list_projects — find a projectId.',
      '3. read_content with just projectId to list files; add fileId to read cells. search_project for full-text search.',
      '4. prepare_translations — stage your writes as a changeset. Nothing is applied yet. Returns { changesetId, digest, summary, mode, approvalUrl? }.',
      '5. confirm_changeset with that changesetId + digest. act mode: applies immediately. ask mode: first show the approvalUrl to a human and wait for them to approve in their browser, then call confirm_changeset — until then it returns confirmation_required and applies nothing.',
    ],
    // All five domain command kinds now ship (Agent API v1.1). PlanImport is
    // the one holdout with no MCP staging tool (prepare_translations's
    // `commands` argument does not accept it) — it stays REST-only (POST
    // .../changesets). CreateProject / UpdateProjectSettings / LinkMedia stage
    // through the SAME prepare_translations / confirm_changeset tools as
    // SetTranslation, via that `commands` argument — see projectLifecycle and
    // linkMedia below for their per-kind rules.
    commandKinds: ['SetTranslation', 'PlanImport', 'CreateProject', 'UpdateProjectSettings', 'LinkMedia'],
    planImport: {
      stagingChannels: ['rest'],
      mcpStagingTool: null,
      maxCellsPerChangeset: PLAN_IMPORT_MAX_CELLS,
      note: 'PlanImport is staged via REST only; no MCP staging tool exists yet.',
    },
    projectLifecycle: {
      mcpStagingTool: 'prepare_translations',
      commitTool: 'confirm_changeset',
      note:
        'CreateProject and UpdateProjectSettings are receipt-only (a plain row write, not an ' +
        'event) — stage via prepare_translations\'s `commands` argument and commit with ' +
        'confirm_changeset exactly like SetTranslation. Each must be the sole command in its ' +
        'changeset. CreateProject requires an unscoped or org-scoped credential with org ' +
        'role >= MAINTAINER (a project-scoped credential gets scope_denied) — and prepare ' +
        'ALWAYS stages CreateProject in ask-mode regardless of credential mode, so it always ' +
        'requires human approval at the approvalUrl before it can commit; a project id ' +
        'claimed by another caller between prepare and commit returns ' +
        'conflict. UpdateProjectSettings requires project role >= MAINTAINER and a matching ' +
        'ifMatchVersion (else plan_stale). Receipt shape: { credentialId, channel, ' +
        'changesetId, command, appliedAt, projectId, version? }.',
    },
    linkMedia: {
      mcpStagingTool: 'prepare_translations',
      commitTool: 'confirm_changeset',
      note:
        'LinkMedia attaches an already-uploaded audio artifact to a cell. Upload the audio ' +
        'bytes first via REST POST .../projects/:projectId/artifacts with header ' +
        '"x-artifact-kind: audio" (MCP is JSON-RPC text and cannot carry that binary body) — ' +
        'see limits.maxArtifactBytes for the size cap. Then stage LinkMedia via ' +
        'prepare_translations\'s `commands` argument. Multiple LinkMedia commands may share ' +
        'one changeset; LinkMedia cannot mix with any other command kind.',
    },
    multiLanguage: {
      note:
        'A project can hold MULTIPLE target languages at once via target-language lanes. A ' +
        'lane is a language tag (e.g. "es", "pt") registered in the project\'s ' +
        'settings.targetLanes array; every cell keeps one shared source plus one independent ' +
        'target per lane. Omitting the lane everywhere uses the default lane (the project\'s ' +
        'single targetLanguage) — existing single-language callers need no changes.',
      workflow: [
        '1. Register the lanes once: stage UpdateProjectSettings with settings.targetLanes: ["es", "pt"] (merge into the existing settings blob — the write replaces it — and pass the live ifMatchVersion).',
        '2. Write per lane: each SetTranslation entry takes an optional laneId ("es" or "pt"). An unregistered laneId is rejected at prepare with validation_failed.',
        '3. Read per lane: read_content takes an optional lane argument — target cells are filtered to that lane (source cells are always included). Omit it to get every lane (each target row carries its targetLang).',
        '4. Importing a file can seed several lanes at once: PlanImport cells take variants: [{ laneId, content }] (REST-only).',
      ],
      preconditionScope:
        'Preconditions and drift (plan_stale) are lane-scoped: concurrent edits to the SAME ' +
        'cell in DIFFERENT lanes never invalidate each other\'s changesets.',
    },
    limits: {
      changesetExpirySeconds: CHANGESET_TTL_MS / 1000,
      // Wave-1 validateCommands enforces no hard per-changeset command cap.
      maxCommandsPerChangeset: null,
      planImportMaxCells: PLAN_IMPORT_MAX_CELLS,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
    },
    errorCodes: ERROR_CODES,
    askModeFlow:
      'In ask mode you can prepare_translations but cannot commit directly. prepare returns ' +
      'an approvalUrl; surface it to a human who opens it in an authenticated Aquilla browser ' +
      'session, reviews the server-computed effect summary, and approves. Then call ' +
      'confirm_changeset — until a human approval is recorded, confirm returns ' +
      'confirmation_required and nothing is applied. In act mode confirm_changeset commits ' +
      'immediately through the same validated pipeline.',
  })
}

function getIdentityAndScope(cred: ApiCredentialContext): McpToolResult {
  return ok({
    userId: cred.userId,
    username: cred.username,
    mode: cred.mode,
    orgId: cred.orgId,
    projectId: cred.projectId,
    credentialId: cred.credentialId,
  })
}

async function listProjects(env: ExternalEnv, cred: ApiCredentialContext): Promise<McpToolResult> {
  if (!env.AQUILLA_PG) return fail('job_failed', 'AQUILLA_PG not configured')
  // Shared with REST GET /api/v1/external/projects (projects-list.ts) so the
  // two adapters can never drift.
  const projects = await listProjectsForCredential(env.AQUILLA_PG, cred)
  return ok({ projects })
}

interface ProjectRow {
  id: string
  name: string
  org_id: number | string | bigint | null
  archived_at: string | null
}

async function getProject(
  env: ExternalEnv,
  cred: ApiCredentialContext,
  projectId: string,
): Promise<McpToolResult> {
  if (!env.AQUILLA_PG) return fail('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    if (err instanceof ExternalError) return fail(err.code, err.message)
    throw err
  }
  const resolved = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!resolved || resolved.level < ROLE.VIEWER) {
    return fail('permission_denied', 'no project membership (VIEWER role required)')
  }
  const row = await db
    .prepare('SELECT id, name, org_id, archived_at FROM projects WHERE id = ?')
    .bind(projectId)
    .first<ProjectRow>()
  if (!row) return fail('not_found', `project ${projectId} not found`)
  return ok({
    id: row.id,
    name: row.name,
    org_id: row.org_id == null ? null : String(row.org_id),
    archived: row.archived_at != null,
    role: resolved.level,
  })
}

// ── delegated reads ──────────────────────────────────────────────────────────

async function runRead(env: ExternalEnv, token: string, path: string): Promise<McpToolResult> {
  const req = new Request(`${EXTERNAL_BASE}/${path}`, { headers: bearer(token) })
  const res = await handleExternalReadRequest(req, env)
  if (!res) return fail('not_found', 'read route did not match')
  if (!res.ok) return delegatedError(res)
  return ok(await res.json())
}

async function searchProject(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const q = str(args, 'q')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!q) return fail('validation_failed', 'q is required')
  const params = new URLSearchParams({ q })
  const side = str(args, 'side')
  if (side) params.set('side', side)
  if (typeof args.limit === 'number') params.set('limit', String(args.limit))
  return runRead(env, token, `${encodeURIComponent(projectId)}/search?${params.toString()}`)
}

async function readContent(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  const params = new URLSearchParams()
  if (typeof args.since === 'number') params.set('since', String(args.since))
  if (typeof args.limit === 'number') params.set('limit', String(args.limit))
  const cursor = str(args, 'cursor')
  if (cursor) params.set('cursor', cursor)
  // AQU-538: optional target-language lane filter, forwarded to the cells read.
  const lane = str(args, 'lane')
  if (lane) params.set('lane', lane)
  const qs = params.toString() ? `?${params.toString()}` : ''
  const fileId = str(args, 'fileId')
  const path = fileId
    ? `${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/cells${qs}`
    : `${encodeURIComponent(projectId)}/files${qs}`
  return runRead(env, token, path)
}

async function readHistory(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const cellId = str(args, 'cellId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!cellId) return fail('validation_failed', 'cellId is required')
  return runRead(env, token, `${encodeURIComponent(projectId)}/cells/${encodeURIComponent(cellId)}/history`)
}

// ── delegated changesets ─────────────────────────────────────────────────────

interface PrepareBody {
  changeset: { id: string; autonomyMode: 'ask' | 'act' }
  summary: unknown
  digest: string
  approvalUrl: string
}

async function prepareTranslations(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  if (!projectId) return fail('validation_failed', 'projectId is required')

  const commands: Record<string, unknown>[] = []

  if (args.translations !== undefined) {
    if (!Array.isArray(args.translations)) {
      return fail('validation_failed', 'translations must be an array')
    }
    commands.push(
      ...(args.translations as Record<string, unknown>[]).map((t) => ({
        kind: 'SetTranslation',
        fileId: t?.fileId,
        cellId: t?.cellId,
        value: t?.value,
        ...(t?.valueHtml !== undefined ? { valueHtml: t.valueHtml } : {}),
        ...(t?.laneId !== undefined ? { laneId: t.laneId } : {}),
      })),
    )
  }

  // Agent API v1.1: CreateProject / UpdateProjectSettings / LinkMedia stage
  // through this SAME tool via a generic `commands` array, passed through
  // as-is — validateCommands (server-side, in the delegated changesets route)
  // is the single source of truth for per-kind shape, sole-command, and
  // scope/role checks, so this adapter does not re-derive any of it.
  if (args.commands !== undefined) {
    if (!Array.isArray(args.commands)) {
      return fail('validation_failed', 'commands must be an array')
    }
    commands.push(...(args.commands as Record<string, unknown>[]))
  }

  if (commands.length === 0) {
    return fail('validation_failed', 'translations or commands must be a non-empty array')
  }

  const body: Record<string, unknown> = { commands }
  const changesetId = str(args, 'changesetId')
  if (changesetId) body.id = changesetId

  const req = new Request(`${EXTERNAL_BASE}/${encodeURIComponent(projectId)}/changesets`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json', ...MCP_CHANNEL_HEADER },
    body: JSON.stringify(body),
  })
  const res = await handleExternalChangesetsRequest(req, env, ctx)
  if (!res) return fail('not_found', 'changesets route did not match')
  if (!res.ok) return delegatedError(res)
  const prep = (await res.json()) as PrepareBody
  const mode = prep.changeset.autonomyMode
  return ok({
    changesetId: prep.changeset.id,
    summary: prep.summary,
    digest: prep.digest,
    mode,
    ...(mode === 'ask'
      ? {
          approvalUrl: prep.approvalUrl,
          nextStep:
            'ask mode: show approvalUrl to a human, wait for approval, then call confirm_changeset with this changesetId and digest.',
        }
      : {
          nextStep: 'act mode: call confirm_changeset with this changesetId and digest to commit.',
        }),
  })
}

async function getChangeset(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const changesetId = str(args, 'changesetId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!changesetId) return fail('validation_failed', 'changesetId is required')
  const req = new Request(
    `${EXTERNAL_BASE}/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(changesetId)}`,
    { headers: bearer(token) },
  )
  const res = await handleExternalChangesetsRequest(req, env)
  if (!res) return fail('not_found', 'changesets route did not match')
  if (!res.ok) return delegatedError(res)
  const b = (await res.json()) as {
    changeset: {
      id: string
      status: string
      summary: unknown
      digest: string
      receipt: unknown
      autonomyMode: string
      expiresAt: string
      committedAt: string | null
    }
    approvalUrl: string
  }
  return ok({
    changesetId: b.changeset.id,
    status: b.changeset.status,
    summary: b.changeset.summary,
    digest: b.changeset.digest,
    receipt: b.changeset.receipt,
    autonomyMode: b.changeset.autonomyMode,
    approvalUrl: b.approvalUrl,
    expiresAt: b.changeset.expiresAt,
    committedAt: b.changeset.committedAt,
  })
}

async function confirmChangeset(
  env: ExternalEnv,
  cred: ApiCredentialContext,
  token: string,
  args: Record<string, unknown>,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const changesetId = str(args, 'changesetId')
  const digest = str(args, 'digest')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!changesetId) return fail('validation_failed', 'changesetId is required')
  if (!digest) return fail('validation_failed', 'digest is required')
  if (!env.AQUILLA_PG) return fail('job_failed', 'AQUILLA_PG not configured')

  // Optimistic-concurrency guard: the digest the agent is confirming must match
  // the stored plan. A mismatch means the plan the agent saw is not the plan on
  // record — surface plan_stale rather than committing something else.
  const cs = await loadChangeset(env.AQUILLA_PG, projectId, changesetId)
  if (!cs) return fail('not_found', `changeset ${changesetId} not found`)
  if (cs.digest !== digest) {
    return fail('plan_stale', 'digest does not match the stored plan — re-prepare')
  }

  const req = new Request(
    `${EXTERNAL_BASE}/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(changesetId)}/commit`,
    { method: 'POST', headers: { ...bearer(token), ...MCP_CHANNEL_HEADER } },
  )
  const res = await handleExternalChangesetsRequest(req, env, ctx)
  if (!res) return fail('not_found', 'changesets route did not match')
  if (res.ok) return ok(await res.json())

  // Ask-mode without a consumed approval → confirmation_required, verbatim, plus
  // the approvalUrl so the agent can route a human to approve. Never fabricated.
  const errResult = await delegatedError(res)
  const parsed = JSON.parse(errResult.content[0].text) as { error: { code: string } }
  if (parsed.error.code === 'confirmation_required') {
    return fail('confirmation_required', 'ask-mode changeset requires a human approval first', {
      approvalUrl: approvalUrlFor(env, changesetId),
    })
  }
  return errResult
}

async function discardChangeset(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const changesetId = str(args, 'changesetId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!changesetId) return fail('validation_failed', 'changesetId is required')
  const req = new Request(
    `${EXTERNAL_BASE}/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(changesetId)}/discard`,
    { method: 'POST', headers: bearer(token) },
  )
  const res = await handleExternalChangesetsRequest(req, env)
  if (!res) return fail('not_found', 'changesets route did not match')
  if (!res.ok) return delegatedError(res)
  const b = (await res.json()) as { changeset: { id: string; status: string } | null }
  return ok({ changesetId: b.changeset?.id ?? changesetId, status: b.changeset?.status ?? null })
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/** Result signalling the tool name is unknown, so the transport emits a
 *  JSON-RPC error rather than a tool result. */
export const UNKNOWN_TOOL = Symbol('unknown-tool')

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  token: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<McpToolResult | typeof UNKNOWN_TOOL> {
  switch (name) {
    case 'get_capabilities':
      return getCapabilities(cred)
    case 'get_identity_and_scope':
      return getIdentityAndScope(cred)
    case 'list_projects':
      return listProjects(env, cred)
    case 'get_project': {
      const projectId = str(args, 'projectId')
      if (!projectId) return fail('validation_failed', 'projectId is required')
      return getProject(env, cred, projectId)
    }
    case 'search_project':
      return searchProject(env, token, args)
    case 'read_content':
      return readContent(env, token, args)
    case 'read_history':
      return readHistory(env, token, args)
    case 'prepare_translations':
      return prepareTranslations(env, token, args, ctx)
    case 'get_changeset':
      return getChangeset(env, token, args)
    case 'confirm_changeset':
      return confirmChangeset(env, cred, token, args, ctx)
    case 'discard_changeset':
      return discardChangeset(env, token, args)
    default:
      return UNKNOWN_TOOL
  }
}
