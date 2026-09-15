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
import { approvalUrlFor, CHANGESET_ASK_TTL_MS, CHANGESET_TTL_MS } from './prepare'
import { WAIT_MAX_TIMEOUT_MS } from './changeset-wait'
import { PLAN_IMPORT_MAX_CELLS } from './commands'
import { MAX_ARTIFACT_BYTES, handleExternalArtifactsRequest } from './artifacts-route'
import { SERVER_PARSEABLE_FILE_TYPES, CLIENT_ONLY_FORMATS } from './import-parse'
import { handleExternalReadRequest } from './read-routes'
import { handleExternalMemoryReadRequest } from './memory-read-routes'
import { handleExternalExportRequest } from './export-route'
import { handleExternalQualityRequest } from './quality-routes'
import { handleExternalChangesetsRequest } from './changesets-route'
import { listProjectsForCredential } from './projects-list'
import { loadProjectDetail } from './project-detail'
import { listOrgsForCredential } from './orgs-list'
import { MAX_SEARCH_PROJECTS } from './search-reads'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { COMMAND_CATALOG } from '../../../db/shared/command-catalog'
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

const EXTERNAL_ROOT = 'https://internal/api/v1/external'
const EXTERNAL_BASE = `${EXTERNAL_ROOT}/projects`

// ── direct reads ─────────────────────────────────────────────────────────────

function getCapabilities(cred: ApiCredentialContext): McpToolResult {
  return ok({
    apiVersion: 'v1',
    credentialMode: cred.mode,
    // The numbered golden path, so a weak agent doesn't have to reconstruct
    // the workflow from per-tool descriptions.
    quickstart: [
      '1. get_identity_and_scope — confirm who you are, your mode (ask|act), and your org/project scope.',
      '2. list_projects — find a projectId. Managing a whole workspace? list_orgs first, then list_projects { orgId } per org.',
      '3. read_content with just projectId to list files; add fileId to read cells. search_project for full-text search in one project, search_projects { projectIds: [...] } across several, find_similar_cells for translation-memory precedents. list_memory for what the copilot has learned about the project (and read_cell_memory for what it is given on one cell).',
      '4. prepare_translations — stage your writes as a changeset. Nothing is applied yet. Returns { changesetId, digest, summary, mode, approvalUrl? }.',
      '5. confirm_changeset with that changesetId + digest. act mode: applies immediately. ask mode: first show the approvalUrl to a human and wait for them to approve in their browser, then call confirm_changeset — until then it returns confirmation_required and applies nothing.',
      '6. export_file — when the work is done, pull the file back out in its delivered format (e.g. USFM for Paratext). See exporting below for the role floor and the fidelity fields to check before you hand the result to anyone.',
    ],
    // All six domain command kinds now ship (Agent API v1.1 + AQU-1221).
    // PlanImport stages via the dedicated preview_import / prepare_import tools
    // (or raw REST PlanImport cells); prepare_translations's `commands`
    // argument still does not accept it. CreateOrg / CreateProject /
    // UpdateProjectSettings / LinkMedia stage through the SAME
    // prepare_translations / confirm_changeset tools as SetTranslation, via
    // that `commands` argument — see projectLifecycle and linkMedia below for
    // their per-kind rules.
    commandKinds: [
      'SetTranslation',
      'PlanImport',
      'CreateOrg',
      'CreateProject',
      'UpdateProjectSettings',
      'LinkMedia',
    ],
    // AQU-926 command registry: the role-agnostic catalog index (every
    // agent-reachable command, incl. the newer PatchSettings / EmitEvents).
    // Static floors only — dynamic checks (org overrides, per-event floors)
    // run at prepare. AQU-1222 shipped the matching describe_command tool, so
    // the full per-command params doc is now one call away from here instead
    // of in-app only.
    commands: {
      index: COMMAND_CATALOG.filter((c) => c.agentReachable).map((c) => ({
        kind: c.kind,
        title: c.title,
        tier: c.tier,
        minRoleLevel: c.minRoleLevel,
      })),
      note:
        'Commands stage via prepare_translations `commands` (or REST .../changesets) and ' +
        'commit via confirm_changeset. Call describe_command({ kind }) for one command\'s ' +
        'full parameter doc (REST: GET /api/v1/external/commands/:kind).',
    },
    planImport: {
      stagingChannels: ['rest', 'mcp'],
      mcpStagingTool: 'prepare_import',
      maxCellsPerChangeset: PLAN_IMPORT_MAX_CELLS,
      note:
        'Stage file imports with prepare_import (server-side parsing of an uploaded ' +
        'artifact — see importing below), or POST raw PlanImport cells to REST ' +
        '.../changesets when you parsed the file yourself.',
    },
    importing: {
      // The artifact-first import workflow (docs/AGENT-API.md §5): preserve the
      // original bytes FIRST, then let the server's built-in parsers turn them
      // into a staged, human-approvable changeset.
      workflow: [
        '1. Upload the ORIGINAL file bytes via REST: POST .../projects/:projectId/artifacts with headers "Authorization: Bearer aqk_..." and "x-artifact-name: <filename>" (body = raw bytes). Upload is REST-only — MCP JSON-RPC cannot carry binary; from Claude Code, curl it. This preserves the original in storage for round-trip export.',
        '2. preview_import { projectId, artifactId } — the server parses with its built-in importers and returns totalCells + the first 10 cells, WITHOUT staging. Pass fileType to override detection.',
        '3. prepare_import (same arguments) — parses again and stages a PlanImport changeset linking the artifact; returns { changesetId, digest, summary, mode, approvalUrl? }.',
        '4. confirm_changeset as usual (ask mode: a human approves at the approvalUrl first).',
      ],
      serverParseableFormats: SERVER_PARSEABLE_FILE_TYPES,
      clientOnlyFormats: CLIENT_ONLY_FORMATS,
      notes:
        'Formats in clientOnlyFormats need DOM/browser parsers and are not yet server-' +
        'parseable — import those through the in-app Import dialog, or parse them yourself ' +
        'and stage raw PlanImport cells over REST. Limits: artifact uploads max ' +
        `${MAX_ARTIFACT_BYTES} bytes (25MB); imports max ${PLAN_IMPORT_MAX_CELLS} cells ` +
        'per changeset. A multi-book USFM artifact parses into one file per book — stage ' +
        'each book separately via resultIndex.',
    },
    exporting: {
      // AQU-858: the mirror of `importing` above — the way a deliverable gets
      // back OUT of Aquilla without a human clicking Export in the app.
      mcpTool: 'export_file',
      restEndpoint: 'GET /api/v1/external/projects/:projectId/files/:fileId/export?lane=<tag>',
      minRoleLevel: ROLE.MAINTAINER,
      maxInlineBytes: MCP_EXPORT_MAX_BYTES,
      note:
        'export_file reconstructs one file from the ORIGINAL artifact preserved at import ' +
        'time with the current translations substituted in (untranslated segments keep their ' +
        'source text, so the output stays valid). Export is gated HIGHER than reading: the ' +
        'floor is the org\'s exportMinRole, MAINTAINER by default, and an org can raise or ' +
        'lower it — permission_denied here will not change on retry. A file imported without ' +
        'a preserved source artifact returns not_found and must be re-imported before it can ' +
        'be exported.',
      fidelity:
        'Check exportMode before delivering: "round-trip" = translations substituted; ' +
        '"raw-original"/"raw-sidecar" = this format has no server-side target serializer yet, ' +
        'so you are getting the preserved ORIGINAL bytes with NO translations in them. For ' +
        'USFM, lossyVerseCount counts verses whose intra-verse markers (footnotes, poetry, ' +
        'character markers) the plain-text substitution dropped; 0 = clean round-trip.',
      binaryAndLargeFiles:
        `Binary results (docx/pptx/idml side-cars) and anything over ${MCP_EXPORT_MAX_BYTES} ` +
        'bytes are not returned inline — export_file fails with validation_failed naming the ' +
        'REST URL to fetch instead, the same MCP-cannot-carry-binary asymmetry as the ' +
        'REST-only artifact upload on the import side.',
    },
    projectLifecycle: {
      mcpStagingTool: 'prepare_translations',
      commitTool: 'confirm_changeset',
      note:
        'CreateOrg, CreateProject and UpdateProjectSettings are receipt-only (a plain row ' +
        'write, not an event) — stage via prepare_translations\'s `commands` argument and ' +
        'commit with confirm_changeset exactly like SetTranslation. Each must be the sole ' +
        'command in its changeset. CreateOrg (AQU-1221) starts a whole new tenant: it takes ' +
        'ONLY a name, requires an UNSCOPED credential (org- or project-scoped gets ' +
        'scope_denied), makes the credential\'s minting user the org OWNER, rejects any ' +
        'tier/billing/entitlement field with validation_failed naming it, and is capped at 5 ' +
        'staged creations per credential per 15 minutes (rate_limited). Its receipt carries ' +
        'orgId, not projectId — feed that orgId to a follow-up CreateProject to populate the ' +
        'new org. CreateProject requires an unscoped or org-scoped credential with org ' +
        'role >= MAINTAINER (a project-scoped credential gets scope_denied) — and prepare ' +
        'ALWAYS stages CreateOrg and CreateProject in ask-mode regardless of credential ' +
        'mode, so they always require human approval at the approvalUrl before they can ' +
        'commit; a project id claimed by another caller between prepare and commit returns ' +
        'conflict. UpdateProjectSettings requires project role >= MAINTAINER and a matching ' +
        'ifMatchVersion (else plan_stale). Receipt shape: { credentialId, channel, ' +
        'changesetId, command, appliedAt, projectId?, orgId?, version? }.',
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
    structure: {
      mcpStagingTool: 'prepare_translations',
      commitTool: 'confirm_changeset',
      commandKinds: ['InsertCell', 'DeleteCell', 'SplitCell'],
      note:
        'Cell-structure commands change a file\'s SHAPE — add a row, remove one, or cut a ' +
        'long source sentence in two — using the same cell-lifecycle events the workspace ' +
        'emits, so the event log is indistinguishable from a human edit. Stage via ' +
        'prepare_translations\'s `commands` argument; each must be the SOLE command in its ' +
        'changeset and requires PROJECT_LEAD. All three are REFUSED on a file imported with ' +
        'preserved export slots (IDML/OOXML locators), because those exporters address ' +
        'cells by locator and a structural change would break the round trip. DeleteCell is ' +
        'refused while the cell still owns validators, waivers, comments, back-translations, ' +
        'audio takes, links or assignment rows. SplitCell requires an explicit `targets` ' +
        '("blank" or "divide"); both halves come out unvalidated either way. MergeCells is ' +
        'NOT available — see docs/AGENT-API.md for why it is deferred.',
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
    // AQU-1236: org-scoped reads. PATs are scoped org-or-project, so a console
    // managing a partner's whole workspace can work from one org-scoped token
    // instead of one token per project.
    orgScopedReads: {
      tools: ['list_orgs', 'list_projects', 'search_projects'],
      note:
        'list_orgs returns the orgs this credential covers; list_projects takes an optional ' +
        'orgId to enumerate one of them; search_projects searches an explicit list of up to ' +
        `${MAX_SEARCH_PROJECTS} projects in one call, each result carrying its projectId. ` +
        'Scope only ever narrows: an org-scoped credential is confined to that org, a ' +
        'project-scoped one to its single project (and that project\'s org), and naming ' +
        'anything outside it returns scope_denied rather than an empty result. ' +
        'search_projects is strict — one unauthorized project in the list fails the whole ' +
        'call, so a result set is never silently partial — and costs one search-rate-limit ' +
        'unit per project searched.',
      maxProjectsPerSearch: MAX_SEARCH_PROJECTS,
    },
    limits: {
      // Act mode. Kept under its original name so existing callers keep reading
      // the TTL that applies when THEY hold the whole loop.
      changesetExpirySeconds: CHANGESET_TTL_MS / 1000,
      // Ask mode waits on a human, so it gets its own, longer deadline
      // (AQU-1177 §3) — publish it rather than let an agent assume one hour.
      changesetExpirySecondsAskMode: CHANGESET_ASK_TTL_MS / 1000,
      changesetWaitMaxTimeoutMs: WAIT_MAX_TIMEOUT_MS,
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

async function listOrgs(env: ExternalEnv, cred: ApiCredentialContext): Promise<McpToolResult> {
  if (!env.AQUILLA_PG) return fail('job_failed', 'AQUILLA_PG not configured')
  // Shared with REST GET /api/v1/external/orgs (orgs-list.ts) — AQU-1236.
  const orgs = await listOrgsForCredential(env.AQUILLA_PG, cred)
  return ok({ orgs })
}

async function listProjects(
  env: ExternalEnv,
  cred: ApiCredentialContext,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (!env.AQUILLA_PG) return fail('job_failed', 'AQUILLA_PG not configured')
  // AQU-1236: an org id from the caller narrows the list, but only inside the
  // credential's own scope — an org-scoped credential naming a different org
  // gets scope_denied, matching the REST route rather than returning [].
  const orgId = str(args, 'orgId')
  if (orgId !== undefined && cred.orgId !== null && cred.orgId !== orgId) {
    return fail('scope_denied', 'credential is not scoped to this org')
  }
  // Shared with REST GET /api/v1/external/projects (projects-list.ts) so the
  // two adapters can never drift.
  const projects = await listProjectsForCredential(
    env.AQUILLA_PG,
    cred,
    orgId !== undefined ? { orgId } : {},
  )
  return ok({ projects })
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
  // AQU-1222: shared with the REST GET /projects/:projectId route so the two
  // adapters cannot drift — and so both carry settingsVersion, the number
  // PatchSettings.ifMatchVersion has to match.
  const detail = await loadProjectDetail(db, projectId, resolved.level)
  if (!detail) return fail('not_found', `project ${projectId} not found`)
  return ok(detail)
}

// ── describe_command ─────────────────────────────────────────────────────────

/** AQU-1222: the command catalog's L2 params doc, previously reachable only
 *  from the in-app agent harness (auth-worker command-tools.ts) even though
 *  get_capabilities.commands pointed external agents at it. Same shared catalog,
 *  so the two describe_command surfaces answer identically.
 *
 *  No role gate: the catalog is static documentation, and every credential
 *  already sees the same index through get_capabilities. Kinds with
 *  agentReachable=false are governance-only and stay indistinguishable from
 *  unknown on every agent surface (audit §6.7). */
function describeCommandTool(args: Record<string, unknown>): McpToolResult {
  const index = COMMAND_CATALOG.filter((c) => c.agentReachable)
  const kind = str(args, 'kind')
  if (!kind) {
    // No kind → the index, so a caller that guessed the argument name wrong
    // still learns what it may ask about instead of just being rejected.
    return ok({
      commands: index.map((c) => ({
        kind: c.kind,
        title: c.title,
        tier: c.tier,
        minRoleLevel: c.minRoleLevel,
        oneLiner: c.oneLiner,
      })),
      note: 'Call describe_command({ kind }) for one command\'s full parameter doc.',
    })
  }

  const entry = index.find((c) => c.kind === kind)
  if (!entry) {
    return fail('not_found', `unknown command "${kind}"`, {
      details: { availableKinds: index.map((c) => c.kind) },
    })
  }
  return ok({
    kind: entry.kind,
    title: entry.title,
    tier: entry.tier,
    minRoleLevel: entry.minRoleLevel,
    oneLiner: entry.oneLiner,
    paramsDoc: entry.paramsDoc,
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

/** Same in-process delegation as runRead, against the Living Memory read
 *  router (AQU-1229) — a separate module, so a separate entry point. */
async function runMemoryRead(
  env: ExternalEnv,
  token: string,
  path: string,
): Promise<McpToolResult> {
  const req = new Request(`${EXTERNAL_BASE}/${path}`, { headers: bearer(token) })
  const res = await handleExternalMemoryReadRequest(req, env)
  if (!res) return fail('not_found', 'memory read route did not match')
  if (!res.ok) return delegatedError(res)
  return ok(await res.json())
}

async function listMemory(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  const params = new URLSearchParams()
  const status = str(args, 'status')
  if (status) params.set('status', status)
  const kind = str(args, 'kind')
  if (kind) params.set('kind', kind)
  if (typeof args.limit === 'number') params.set('limit', String(args.limit))
  const cursor = str(args, 'cursor')
  if (cursor) params.set('cursor', cursor)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return runMemoryRead(env, token, `${encodeURIComponent(projectId)}/memory${qs}`)
}

async function readCellMemory(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const fileId = str(args, 'fileId')
  const cellId = str(args, 'cellId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!fileId) return fail('validation_failed', 'fileId is required')
  if (!cellId) return fail('validation_failed', 'cellId is required')
  return runMemoryRead(
    env,
    token,
    `${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/cells/${encodeURIComponent(cellId)}/memory`,
  )
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

// AQU-1232: translation-memory retrieval. Same delegation shape as
// search_project — the REST route owns the ranking, this is argument marshalling.
async function findSimilarCells(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  const cellId = str(args, 'cellId')
  const text = str(args, 'text')
  if (!cellId && !text) return fail('validation_failed', 'one of cellId or text is required')
  if (cellId && text) return fail('validation_failed', 'pass either cellId or text, not both')
  const params = new URLSearchParams()
  if (cellId) params.set('cellId', cellId)
  if (text) params.set('text', text)
  if (typeof args.limit === 'number') params.set('limit', String(args.limit))
  return runRead(env, token, `${encodeURIComponent(projectId)}/similar?${params.toString()}`)
}

/** Cross-project search (AQU-1236) — delegates to REST
 *  GET /api/v1/external/search, which sits at the external ROOT rather than
 *  under /projects, so it cannot use runRead's project-scoped base. */
async function searchProjects(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const q = str(args, 'q')
  if (!q) return fail('validation_failed', 'q is required')
  if (!Array.isArray(args.projectIds)) {
    return fail('validation_failed', 'projectIds must be an array of project ids')
  }
  const projectIds = args.projectIds.filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (projectIds.length === 0) {
    return fail('validation_failed', 'projectIds must be a non-empty array of project ids')
  }
  if (projectIds.length > MAX_SEARCH_PROJECTS) {
    return fail(
      'validation_failed',
      `too many projects: ${projectIds.length} requested, max ${MAX_SEARCH_PROJECTS} per call`,
    )
  }

  const params = new URLSearchParams({ q, projectIds: projectIds.join(',') })
  const side = str(args, 'side')
  if (side) params.set('side', side)
  if (typeof args.limit === 'number') params.set('limit', String(args.limit))

  const req = new Request(`${EXTERNAL_ROOT}/search?${params.toString()}`, { headers: bearer(token) })
  const res = await handleExternalReadRequest(req, env)
  if (!res) return fail('not_found', 'read route did not match')
  if (!res.ok) return delegatedError(res)
  return ok(await res.json())
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

/** AQU-1230 — the assembled copilot prompt for one cell. Delegates to the REST
 *  read so auth, scope, role and rate limiting stay in one place. */
async function getPromptPreview(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const cellId = str(args, 'cellId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!cellId) return fail('validation_failed', 'cellId is required')
  const params = new URLSearchParams()
  const targetLang = str(args, 'targetLang')
  // '' is a MEANINGFUL lane (the default lane) and is also the route's own
  // default, so it need not be sent.
  if (targetLang) params.set('targetLang', targetLang)
  const fileId = str(args, 'fileId')
  if (fileId) params.set('fileId', fileId)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return runRead(
    env,
    token,
    `${encodeURIComponent(projectId)}/cells/${encodeURIComponent(cellId)}/prompt-preview${qs}`,
  )
}

// ── delegated quality reads (AQU-1231) ───────────────────────────────────────

/** Same delegation shape as runRead, against the quality router. */
async function runQualityRead(env: ExternalEnv, token: string, path: string): Promise<McpToolResult> {
  const req = new Request(`${EXTERNAL_BASE}/${path}`, { headers: bearer(token) })
  const res = await handleExternalQualityRequest(req, env)
  if (!res) return fail('not_found', 'quality route did not match')
  if (!res.ok) return delegatedError(res)
  return ok(await res.json())
}

/** fileId / lane / limit / offset — shared by both quality tools. */
function qualityParams(args: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams()
  const fileId = str(args, 'fileId')
  if (fileId) params.set('fileId', fileId)
  const lane = str(args, 'lane')
  if (lane) params.set('lane', lane)
  if (typeof args.limit === 'number') params.set('limit', String(args.limit))
  if (typeof args.offset === 'number') params.set('offset', String(args.offset))
  return params
}

async function readQuality(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  const qs = qualityParams(args).toString()
  return runQualityRead(env, token, `${encodeURIComponent(projectId)}/quality${qs ? `?${qs}` : ''}`)
}

async function readTermConsistency(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  const params = qualityParams(args)
  if (args.onlyDrift === true) params.set('onlyDrift', '1')
  const qs = params.toString()
  return runQualityRead(
    env,
    token,
    `${encodeURIComponent(projectId)}/terms/consistency${qs ? `?${qs}` : ''}`,
  )
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

// ── delegated import parsing (preview_import / prepare_import) ───────────────

/** Shared argument marshalling for the two import tools: both delegate to the
 *  REST parse route (artifacts-route → import-parse.ts) via a synthetic
 *  in-process request, so format detection, the TranslatableString →
 *  PlanImportCell mapping, and (for staging) the whole handlePrepare pipeline
 *  come from ONE implementation. `stage` is the only difference. */
async function runParseArtifact(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
  stage: boolean,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const artifactId = str(args, 'artifactId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!artifactId) return fail('validation_failed', 'artifactId is required')

  const body: Record<string, unknown> = { stage }
  for (const key of ['fileType', 'fileName', 'sourceLanguage', 'targetLanguage', 'changesetId'] as const) {
    const v = str(args, key)
    if (v) body[key] = v
  }
  if (typeof args.resultIndex === 'number') body.resultIndex = args.resultIndex
  if (typeof args.excludeFrontMatter === 'boolean') body.excludeFrontMatter = args.excludeFrontMatter

  const req = new Request(
    `${EXTERNAL_BASE}/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/parse`,
    {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json', ...MCP_CHANNEL_HEADER },
      body: JSON.stringify(body),
    },
  )
  const res = await handleExternalArtifactsRequest(req, env)
  if (!res) return fail('not_found', 'artifacts route did not match')
  if (!res.ok) return delegatedError(res)

  if (!stage) return ok(await res.json())

  // Staged: reshape like prepare_translations so agents branch identically.
  const prep = (await res.json()) as PrepareBody & { parse: unknown }
  const mode = prep.changeset.autonomyMode
  return ok({
    changesetId: prep.changeset.id,
    summary: prep.summary,
    digest: prep.digest,
    mode,
    parse: prep.parse,
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

// ── delegated export (AQU-858) ───────────────────────────────────────────────

/** Ceiling on an export returned inline through MCP. A JSON-RPC tool result is
 *  text in a conversation, so a whole Bible-sized file would blow the client's
 *  context long before it blew any wire limit. Above this the tool names the
 *  REST URL instead of truncating — silently half-delivering a deliverable is
 *  the one failure mode an export must never have. */
export const MCP_EXPORT_MAX_BYTES = 512 * 1024

/** Pull the suggested filename out of a Content-Disposition header. */
function dispositionFileName(header: string | null): string | undefined {
  const match = header?.match(/filename="([^"]*)"/)
  return match?.[1] || undefined
}

async function exportFile(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const fileId = str(args, 'fileId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!fileId) return fail('validation_failed', 'fileId is required')
  if (!env.SNAPSHOTS) return fail('job_failed', 'SNAPSHOTS binding not configured')

  const lane = str(args, 'lane')
  const qs = lane ? `?lane=${encodeURIComponent(lane)}` : ''
  const restPath = `/api/v1/external/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/export${qs}`

  const res = await handleExternalExportRequest(
    new Request(`https://internal${restPath}`, { headers: bearer(token) }),
    { ...env, SNAPSHOTS: env.SNAPSHOTS },
  )
  if (!res) return fail('not_found', 'export route did not match')
  if (!res.ok) return delegatedError(res)

  const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream'
  const fileName = dispositionFileName(res.headers.get('Content-Disposition')) ?? fileId
  // The internal route only stamps X-Export-Mode on the fallbacks that hand
  // back preserved bytes; its absence means translations WERE substituted.
  const exportMode = res.headers.get('X-Export-Mode') ?? 'round-trip'
  const lossyHeader = res.headers.get('X-Usfm-Lossy-Verse-Count')

  if (!contentType.startsWith('text/')) {
    return fail(
      'validation_failed',
      `"${fileName}" exports as ${contentType}, which MCP (JSON-RPC text) cannot carry — ` +
        `fetch the bytes over REST instead: GET ${restPath}`,
      { restPath, contentType, exportMode },
    )
  }

  const content = await res.text()
  const bytes = new TextEncoder().encode(content).length
  if (bytes > MCP_EXPORT_MAX_BYTES) {
    return fail(
      'validation_failed',
      `"${fileName}" is ${bytes} bytes, over the ${MCP_EXPORT_MAX_BYTES}-byte inline export ` +
        `limit — fetch it over REST instead: GET ${restPath}`,
      { restPath, bytes, maxBytes: MCP_EXPORT_MAX_BYTES, exportMode },
    )
  }

  return ok({
    fileName,
    contentType,
    exportMode,
    ...(lossyHeader === null ? {} : { lossyVerseCount: Number(lossyHeader) }),
    bytes,
    content,
    ...(exportMode === 'round-trip'
      ? {}
      : {
          warning:
            'This is the preserved ORIGINAL artifact — no translations are substituted into it, ' +
            'because this format has no server-side target serializer yet. Do not deliver it as a translation.',
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

/** Wire shape of one changeset in the delegated REST responses. */
interface ChangesetWire {
  id: string
  status: string
  summary: unknown
  digest: string
  receipt: unknown
  autonomyMode: string
  createdAt: string
  expiresAt: string
  committedAt: string | null
  approvalUrl?: string
}

/** Trim a changeset to the fields an agent acts on. The full commands and
 *  preconditions arrays are deliberately omitted from LIST results — an agent
 *  paging its inbox wants status and effect counts, not every plan re-serialized
 *  (get_changeset returns the whole record when it actually needs it). */
function changesetDigestView(cs: ChangesetWire, approvalUrl: string): Record<string, unknown> {
  return {
    changesetId: cs.id,
    status: cs.status,
    autonomyMode: cs.autonomyMode,
    summary: cs.summary,
    digest: cs.digest,
    approvalUrl,
    createdAt: cs.createdAt,
    expiresAt: cs.expiresAt,
    committedAt: cs.committedAt,
  }
}

async function listChangesets(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  const qs = new URLSearchParams()
  const status = str(args, 'status')
  if (status) qs.set('status', status)
  const limit = args.limit
  if (typeof limit === 'number') qs.set('limit', String(limit))
  const cursor = str(args, 'cursor')
  if (cursor) qs.set('cursor', cursor)

  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const req = new Request(
    `${EXTERNAL_BASE}/${encodeURIComponent(projectId)}/changesets${suffix}`,
    { headers: bearer(token) },
  )
  const res = await handleExternalChangesetsRequest(req, env)
  if (!res) return fail('not_found', 'changesets route did not match')
  if (!res.ok) return delegatedError(res)
  const b = (await res.json()) as { changesets: ChangesetWire[]; nextCursor: string | null }
  return ok({
    changesets: b.changesets.map((cs) => changesetDigestView(cs, cs.approvalUrl ?? '')),
    nextCursor: b.nextCursor,
  })
}

async function waitForChangeset(
  env: ExternalEnv,
  token: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const projectId = str(args, 'projectId')
  const changesetId = str(args, 'changesetId')
  if (!projectId) return fail('validation_failed', 'projectId is required')
  if (!changesetId) return fail('validation_failed', 'changesetId is required')
  const timeoutMs = args.timeoutMs
  const qs =
    typeof timeoutMs === 'number' ? `?timeoutMs=${encodeURIComponent(String(timeoutMs))}` : ''

  const req = new Request(
    `${EXTERNAL_BASE}/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(changesetId)}/wait${qs}`,
    { headers: bearer(token) },
  )
  const res = await handleExternalChangesetsRequest(req, env)
  if (!res) return fail('not_found', 'changesets route did not match')
  if (!res.ok) return delegatedError(res)
  const b = (await res.json()) as {
    changeset: ChangesetWire
    approvalUrl: string
    approved: boolean
    timedOut: boolean
    waitedMs: number
  }
  return ok({
    ...changesetDigestView(b.changeset, b.approvalUrl),
    approved: b.approved,
    // Not an error: the human simply hasn't decided yet. Call again.
    timedOut: b.timedOut,
    waitedMs: b.waitedMs,
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
    case 'list_orgs':
      return listOrgs(env, cred)
    case 'list_projects':
      return listProjects(env, cred, args)
    case 'get_project': {
      const projectId = str(args, 'projectId')
      if (!projectId) return fail('validation_failed', 'projectId is required')
      return getProject(env, cred, projectId)
    }
    case 'describe_command':
      return describeCommandTool(args)
    case 'search_project':
      return searchProject(env, token, args)
    case 'find_similar_cells':
      return findSimilarCells(env, token, args)
    case 'search_projects':
      return searchProjects(env, token, args)
    case 'read_content':
      return readContent(env, token, args)
    case 'read_history':
      return readHistory(env, token, args)
    case 'get_prompt_preview':
      return getPromptPreview(env, token, args)
    case 'list_memory':
      return listMemory(env, token, args)
    case 'read_cell_memory':
      return readCellMemory(env, token, args)
    case 'read_quality':
      return readQuality(env, token, args)
    case 'read_term_consistency':
      return readTermConsistency(env, token, args)
    case 'prepare_translations':
      return prepareTranslations(env, token, args, ctx)
    case 'preview_import':
      return runParseArtifact(env, token, args, false)
    case 'prepare_import':
      return runParseArtifact(env, token, args, true)
    case 'export_file':
      return exportFile(env, token, args)
    case 'get_changeset':
      return getChangeset(env, token, args)
    case 'list_changesets':
      return listChangesets(env, token, args)
    case 'wait_for_changeset':
      return waitForChangeset(env, token, args)
    case 'confirm_changeset':
      return confirmChangeset(env, cred, token, args, ctx)
    case 'discard_changeset':
      return discardChangeset(env, token, args)
    default:
      return UNKNOWN_TOOL
  }
}
