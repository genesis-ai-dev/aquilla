// POST /api/v1/external/projects/:projectId/changesets/:id/commit
//
// The one commit pipeline for both autonomy modes (AQU-533 §3):
//   staged? → expiry → (ask: consume one-time confirmation | act: proceed)
//   → re-check preconditions (plan_stale on drift) → compile commands into
//   target.cell.commit events → route through the /events perimeter via an
//   internal minted token → stamp provenance → write receipt → committed.
//
// Idempotent: a committed changeset returns its stored receipt without
// re-applying. Ask-mode confirmations are consumed exactly once.

import { errorResponse, toErrorResponse } from './errors'
import {
  cellKey,
  requiredRoleForCommand,
  type PlanImportCommand,
  type SetTranslationCommand,
} from './commands'
import { resolveCellStates } from './preconditions'
import { loadChangeset } from './store'
import { mintInternalSyncToken } from './token-bridge'
import { uuidv7 } from './uuid'
import { handleEventsWriteRequest } from '../events/route'
import type { RawEvent } from '../events/types'
import type { ChangesetReceipt, ChangesetWarning, ExternalEnv, StoredChangeset } from './types'
import { validateApiCredential, type ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'

/** Provenance channel for the commit request. MCP-originated commits arrive via
 *  a synthetic in-process Request carrying `x-aquilla-channel: mcp`
 *  (mcp-handlers.ts); everything else is a direct REST call. Only these two
 *  values are accepted — an unknown/absent header defaults to 'rest'. */
function readChannel(request: Request): 'mcp' | 'rest' {
  return request.headers.get('x-aquilla-channel') === 'mcp' ? 'mcp' : 'rest'
}

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

interface EventsWriteResponse {
  accepted: { id: string }[]
  rejected: { id: string; status: number; reason: string }[]
  stale?: { id: string; fileId: string | null; cellId: string | null }[]
  staleSource?: { id: string; currentSourceEventId: string }[]
}

export async function handleCommit(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  id: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG

  const cred = await validateApiCredential(db, bearer(request) ?? "")
  if (!cred) return errorResponse('permission_denied', 'invalid or missing API credential')

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)

  // A changeset is committed by the credential that staged it.
  if (cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }

  // ── Status gate ──────────────────────────────────────────────────────────
  if (cs.status === 'committed') {
    // Idempotent: return the stored receipt, do NOT re-apply.
    return Response.json({ receipt: cs.receipt })
  }
  if (cs.status === 'discarded') {
    return errorResponse('validation_failed', 'changeset was discarded')
  }
  if (cs.status === 'expired') {
    return errorResponse('validation_failed', 'changeset has expired')
  }
  if (cs.status === 'stale') {
    return errorResponse('plan_stale', 'changeset is stale — prepare a new plan')
  }
  // status === 'staged' from here.

  // ── Live role/membership precheck (§2) ────────────────────────────────────
  // Resolve the caller's CURRENT role and require the floor of the command kinds
  // being committed. The /events perimeter re-checks per-event roles as the
  // backstop, but resolving here first means a member removed after prepare is
  // denied cleanly (permission_denied) instead of half-applying at the perimeter.
  const requiredRole = Math.max(...cs.commands.map(requiredRoleForCommand))
  const resolvedRole = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!resolvedRole || resolvedRole.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role to commit this changeset')
  }

  // ── Expiry ────────────────────────────────────────────────────────────────
  if (new Date(cs.expiresAt).getTime() < Date.now()) {
    await db.prepare(`UPDATE changesets SET status = 'expired' WHERE id = ?`).bind(id).run()
    return errorResponse('validation_failed', 'changeset has expired')
  }

  // ── Autonomy: ask requires a consumed one-time confirmation ───────────────
  let confirmationId: string | null = null
  if (cs.autonomyMode === 'ask') {
    const consumed = await db
      .prepare(
        `UPDATE changeset_confirmations SET consumed_at = now()
           WHERE changeset_id = ? AND credential_id = ? AND digest = ?
             AND consumed_at IS NULL AND expires_at > now()
         RETURNING id`,
      )
      .bind(id, cs.credentialId, cs.digest)
      .first<{ id: string }>()
    if (!consumed) {
      return errorResponse(
        'confirmation_required',
        'ask-mode changeset requires a valid, unconsumed human approval',
      )
    }
    confirmationId = consumed.id
  }

  // ── Re-check preconditions against the live projection ────────────────────
  const liveStates = await resolveCellStates(db, projectId, cs.preconditions)
  const drift: { fileId: string; cellId: string }[] = []
  for (const pre of cs.preconditions) {
    const s = liveStates.get(cellKey(pre.fileId, pre.cellId))
    const liveHead = s?.targetHeadEventId ?? null
    const liveSource = s?.sourceEventId ?? null
    if (liveHead !== pre.targetHeadEventId || liveSource !== pre.sourceEventId) {
      drift.push({ fileId: pre.fileId, cellId: pre.cellId })
    }
  }
  if (drift.length > 0) {
    await db.prepare(`UPDATE changesets SET status = 'stale' WHERE id = ?`).bind(id).run()
    return errorResponse('plan_stale', 'project state changed since prepare', { drift })
  }

  // ── PlanImport takes its own compile/commit path ──────────────────────────
  const planImport = cs.commands.find(
    (c): c is PlanImportCommand => c.kind === 'PlanImport',
  )
  if (planImport) {
    return commitPlanImport(request, env, db, cred, cs, planImport, confirmationId, ctx)
  }

  // ── Compile commands → target.cell.commit events, grouped by file ─────────
  // Past the PlanImport branch every remaining command is a SetTranslation.
  const commandByCell = new Map<string, SetTranslationCommand>()
  for (const c of cs.commands) {
    if (c.kind !== 'SetTranslation') continue
    commandByCell.set(cellKey(c.fileId, c.cellId), c)
  }

  const eventsByFile = new Map<string, RawEvent<'target.cell.commit'>[]>()
  const allEventIds: string[] = []
  const clientTs = Date.now()
  for (const pre of cs.preconditions) {
    const cmd = commandByCell.get(cellKey(pre.fileId, pre.cellId))
    if (!cmd) continue
    const ev: RawEvent<'target.cell.commit'> = {
      id: uuidv7(),
      schemaVersion: 1,
      kind: 'target.cell.commit',
      projectId,
      fileId: pre.fileId,
      cellId: pre.cellId,
      parentId: pre.targetHeadEventId,
      author: cred.username,
      payload: {
        value: cmd.value,
        ...(cmd.valueHtml !== undefined ? { valueHtml: cmd.valueHtml } : {}),
        sourceEventId: pre.sourceEventId,
      },
      clientTs,
    }
    allEventIds.push(ev.id)
    const list = eventsByFile.get(pre.fileId)
    if (list) list.push(ev)
    else eventsByFile.set(pre.fileId, [ev])
  }

  // ── Route each file's events through the /events perimeter ────────────────
  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
  const staleFromPerimeter: string[] = []
  const staleSource: string[] = []

  for (const [fileId, events] of eventsByFile) {
    let token: string
    try {
      token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
    } catch (err) {
      return toErrorResponse(err)
    }
    const req = new Request('https://internal/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    })
    const res = await handleEventsWriteRequest(req, env, ctx)
    if (!res) return errorResponse('job_failed', 'events perimeter did not respond')
    const out = (await res.json()) as EventsWriteResponse
    for (const a of out.accepted) acceptedIds.add(a.id)
    for (const r of out.rejected) rejected.push(r)
    for (const s of out.stale ?? []) staleFromPerimeter.push(s.id)
    for (const s of out.staleSource ?? []) staleSource.push(s.id)
  }

  // If nothing applied but the perimeter rejected events, surface the reason.
  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  // ── Stamp the server-verified provenance envelope on applied events ───────
  let agentMeta: unknown = null
  const agentHeader = request.headers.get('x-agent-meta')
  if (agentHeader) {
    try {
      agentMeta = JSON.parse(agentHeader)
    } catch {
      agentMeta = null // invalid caller metadata is recorded as absent, not fatal.
    }
  }
  const provenance = {
    origin: 'agent',
    human_authority: { user_id: cs.createdByUserId, credential_id: cs.credentialId },
    agent: agentMeta,
    channel: readChannel(request),
    autonomy_mode: cs.autonomyMode,
    changeset_id: cs.id,
    ...(confirmationId ? { confirmation_id: confirmationId } : {}),
  }
  const appliedIds = allEventIds.filter((eid) => acceptedIds.has(eid))
  if (appliedIds.length > 0) {
    const placeholders = appliedIds.map(() => '?').join(', ')
    await db
      .prepare(`UPDATE events SET provenance = ?::jsonb WHERE id IN (${placeholders})`)
      .bind(JSON.stringify(provenance), ...appliedIds)
      .run()
  }

  // ── Receipt ───────────────────────────────────────────────────────────────
  const warnings: ChangesetWarning[] = [...cs.summary.warnings]
  for (const r of rejected) {
    warnings.push({ code: 'rejected', fileId: '', cellId: '', message: `${r.id}: ${r.reason}` })
  }
  for (const eid of [...staleFromPerimeter, ...staleSource]) {
    warnings.push({ code: 'stale_pin', fileId: '', cellId: '', message: `event ${eid} landed stale` })
  }

  const committedAt = new Date().toISOString()
  const receipt: ChangesetReceipt = {
    eventIds: appliedIds,
    appliedCount: appliedIds.length,
    staleCount: staleFromPerimeter.length + staleSource.length,
    warnings,
    committedAt,
  }

  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, id)
    .run()

  return Response.json({ receipt })
}

/** Parse the caller-declared agent metadata header (recorded, never verified). */
function readAgentMeta(request: Request): unknown {
  const header = request.headers.get('x-agent-meta')
  if (!header) return null
  try {
    return JSON.parse(header)
  } catch {
    return null
  }
}

/** Build the server-verified provenance envelope (§2). */
function buildProvenance(
  request: Request,
  cs: StoredChangeset,
  confirmationId: string | null,
): Record<string, unknown> {
  return {
    origin: 'agent',
    human_authority: { user_id: cs.createdByUserId, credential_id: cs.credentialId },
    agent: readAgentMeta(request),
    channel: readChannel(request),
    autonomy_mode: cs.autonomyMode,
    changeset_id: cs.id,
    ...(confirmationId ? { confirmation_id: confirmationId } : {}),
  }
}

/** Statements per POST to the /events perimeter — mirrors the perimeter's own
 *  BATCH_LIMIT (100). A PlanImport can seed thousands of source cells, so the
 *  compiled events are chunked; the receipt reports applied counts accurately
 *  across chunks (all-or-nothing is not required, but a partial apply is
 *  surfaced honestly and fails the changeset — no silent truncation). */
const PLAN_IMPORT_CHUNK = 100

/**
 * Compile a PlanImport into one file.create + N genesis source.cell.create
 * events (chained by anchorCellId, mirroring the SPA import + bulk /import
 * semantics), route them through the SAME /events perimeter Wave 1 uses (source.*
 * requires PROJECT_LEAD (500) — a contributor credential is 403'd there), stamp
 * provenance on applied events, link the artifact, and write the receipt.
 */
async function commitPlanImport(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: PlanImportCommand,
  confirmationId: string | null,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<Response> {
  const projectId = cs.projectId
  const fileId = uuidv7()
  const clientTs = Date.now()

  const fileEvent: RawEvent<'file.create'> = {
    id: uuidv7(),
    schemaVersion: 1,
    kind: 'file.create',
    projectId,
    fileId,
    parentId: null,
    author: cred.username,
    payload: {
      name: cmd.fileName,
      fileType: cmd.fileType,
      ...(cmd.sourceLanguage !== undefined ? { sourceLanguage: cmd.sourceLanguage } : {}),
      ...(cmd.targetLanguage !== undefined ? { targetLanguage: cmd.targetLanguage } : {}),
    },
    clientTs,
  }

  // Genesis source cells, chained via anchorCellId (null for the first cell).
  const cellEvents: RawEvent<'source.cell.create'>[] = []
  let prevCellId: string | null = null
  for (const cell of cmd.cells) {
    const cellId = cell.id ?? uuidv7()
    cellEvents.push({
      id: uuidv7(),
      schemaVersion: 1,
      kind: 'source.cell.create',
      projectId,
      fileId,
      cellId,
      parentId: null,
      author: cred.username,
      payload: {
        cellId,
        anchorCellId: prevCellId,
        value: cell.content,
        ...(cell.canonicalRef !== undefined ? { canonicalRef: cell.canonicalRef } : {}),
        ...(cell.type !== undefined ? { type: cell.type } : {}),
        ...(cell.section !== undefined ? { metadata: { section: cell.section } } : {}),
      },
      clientTs,
    })
    prevCellId = cellId
  }

  // file.create must land in the first chunk (it seeds the files row).
  const allEvents: RawEvent[] = [fileEvent, ...cellEvents]
  const allEventIds = allEvents.map((e) => e.id)

  let token: string
  try {
    token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
  for (let i = 0; i < allEvents.length; i += PLAN_IMPORT_CHUNK) {
    const chunk = allEvents.slice(i, i + PLAN_IMPORT_CHUNK)
    const req = new Request('https://internal/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: chunk }),
    })
    const res = await handleEventsWriteRequest(req, env, ctx)
    if (!res) return errorResponse('job_failed', 'events perimeter did not respond')
    const out = (await res.json()) as EventsWriteResponse
    for (const a of out.accepted) acceptedIds.add(a.id)
    for (const r of out.rejected) rejected.push(r)
  }

  // Nothing applied but events were rejected — surface the reason (a contributor
  // credential is 403'd by the perimeter since source.* needs PROJECT_LEAD 500).
  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  // Stamp provenance on the applied events.
  const provenance = buildProvenance(request, cs, confirmationId)
  const appliedIds = allEventIds.filter((eid) => acceptedIds.has(eid))
  if (appliedIds.length > 0) {
    const placeholders = appliedIds.map(() => '?').join(', ')
    await db
      .prepare(`UPDATE events SET provenance = ?::jsonb WHERE id IN (${placeholders})`)
      .bind(JSON.stringify(provenance), ...appliedIds)
      .run()
  }

  // Link the uploaded artifact to the created file, if one was referenced.
  const fileApplied = acceptedIds.has(fileEvent.id)
  if (cmd.artifactId && fileApplied) {
    await db
      .prepare(`UPDATE artifacts SET file_id = ? WHERE id::text = ? AND project_id = ?`)
      .bind(fileId, cmd.artifactId, projectId)
      .run()
  }

  const warnings: ChangesetWarning[] = [...cs.summary.warnings]
  for (const r of rejected) {
    warnings.push({ code: 'rejected', fileId: '', cellId: '', message: `${r.id}: ${r.reason}` })
  }

  const receipt: ChangesetReceipt = {
    eventIds: appliedIds,
    appliedCount: appliedIds.length,
    staleCount: 0,
    warnings,
    committedAt: new Date().toISOString(),
    fileId,
  }

  // Mark committed regardless of partial rejects: event ids are regenerated on
  // each attempt, so a retry after a partial apply would create a DUPLICATE
  // file. Committing (idempotently returning this receipt on re-commit) is the
  // safe choice; a partial apply is reported as job_failed with the receipt.
  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, cs.id)
    .run()

  if (rejected.length > 0) {
    // Partial apply: honest accounting — the changeset failed even though some
    // events landed. The receipt carries the accurate applied count + rejects.
    return errorResponse('job_failed', 'import partially failed — some events were rejected', {
      receipt,
    })
  }

  return Response.json({ receipt })
}
