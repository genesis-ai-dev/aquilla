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
  type LinkMediaCommand,
  type PlanImportCommand,
  type SetTranslationCommand,
} from './commands'
import { resolveCellStates } from './preconditions'
import { loadChangeset } from './store'
import { mintInternalSyncToken } from './token-bridge'
import { uuidv7 } from './uuid'
import { audioObjectKey } from '../audio'
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
  // status is 'staged' (first attempt) or 'committing' (crash-retry, W1-B §4)
  // from here.

  // ── Live role/membership precheck (§2) ────────────────────────────────────
  // Resolve the caller's CURRENT role and require the floor of the command kinds
  // being committed. The /events perimeter re-checks per-event roles as the
  // backstop, but resolving here first means a member removed after prepare is
  // denied cleanly (permission_denied) instead of half-applying at the perimeter.
  // Runs for a crash-retry too — a member removed mid-commit is still stopped.
  const requiredRole = Math.max(...cs.commands.map(requiredRoleForCommand))
  const resolvedRole = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!resolvedRole || resolvedRole.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role to commit this changeset')
  }

  // ── First-attempt gates (staged only) ─────────────────────────────────────
  // Expiry, one-time ask-mode approval, and precondition drift are checked ONCE,
  // on the first commit attempt. A crash-retry (status='committing') skips them:
  //   • expiry — the plan is already mid-apply; blocking would strand partially
  //     applied events;
  //   • confirmation — already consumed on the first attempt; re-consuming would
  //     wrongly demand a second approval (the id was persisted at the flip below);
  //   • drift — our OWN partial apply legitimately moved the head, so a re-check
  //     would false-positive; the stored ids + /events idempotency make the
  //     re-apply safe regardless.
  let confirmationId: string | null = cs.confirmationId ?? null
  if (cs.status === 'staged') {
    // Expiry.
    if (new Date(cs.expiresAt).getTime() < Date.now()) {
      await db.prepare(`UPDATE changesets SET status = 'expired' WHERE id = ?`).bind(id).run()
      return errorResponse('validation_failed', 'changeset has expired')
    }

    // Autonomy: ask requires a consumed one-time confirmation.
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

    // Re-check preconditions against the live projection.
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

    // Flip to 'committing' before applying and persist the consumed confirmation
    // id, so a crash after this point re-enters as a retry (skipping the gates
    // above) and can rebuild provenance without a second approval. Guarded on
    // status='staged' so a concurrent double-commit can't both flip.
    await db
      .prepare(
        `UPDATE changesets SET status = 'committing', confirmation_id = ?
           WHERE id = ? AND status = 'staged'`,
      )
      .bind(confirmationId, id)
      .run()
  }

  // ── PlanImport takes its own compile/commit path ──────────────────────────
  const planImport = cs.commands.find(
    (c): c is PlanImportCommand => c.kind === 'PlanImport',
  )
  if (planImport) {
    return commitPlanImport(request, env, db, cred, cs, planImport, confirmationId, ctx)
  }

  // ── LinkMedia takes its own compile/commit path ───────────────────────────
  const linkMedia = cs.commands.filter(
    (c): c is LinkMediaCommand => c.kind === 'LinkMedia',
  )
  if (linkMedia.length > 0) {
    return commitLinkMedia(request, env, db, cred, cs, linkMedia, confirmationId, ctx)
  }

  // ── Compile commands → target.cell.commit events, grouped by file ─────────
  // Past the PlanImport branch every remaining command is a SetTranslation.
  const commandByCell = new Map<string, SetTranslationCommand>()
  for (const c of cs.commands) {
    if (c.kind !== 'SetTranslation') continue
    commandByCell.set(cellKey(c.fileId, c.cellId), c)
  }

  // W1-B: consume the event ids minted at prepare, so a crash-retry re-posts
  // identical ids (deduped by the /events layer). The ledger is a list; rebuild
  // the cellKey lookup in memory (its NUL separator is fine as a Map key, unlike
  // a jsonb object key). Fall back to minting for changesets staged before the
  // planned-id ledger existed (backward compat).
  const plannedSet = new Map(
    (cs.plannedIds?.setTranslation ?? []).map((p) => [cellKey(p.fileId, p.cellId), p.eventId]),
  )
  const eventsByFile = new Map<string, RawEvent<'target.cell.commit'>[]>()
  const allEventIds: string[] = []
  const clientTs = Date.now()
  for (const pre of cs.preconditions) {
    const cmd = commandByCell.get(cellKey(pre.fileId, pre.cellId))
    if (!cmd) continue
    const ev: RawEvent<'target.cell.commit'> = {
      id: plannedSet.get(cellKey(pre.fileId, pre.cellId)) ?? uuidv7(),
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
  const clientTs = Date.now()

  // W1-B (§4): consume the file id, file.create event id, and per-cell ids
  // minted at prepare. A crash-retry re-posts these IDENTICAL ids, so the
  // /events idempotency layer (INSERT OR IGNORE on event id) dedupes them — no
  // duplicate file, no duplicate source cells. Fall back to minting for
  // changesets staged before the planned-id ledger existed (backward compat).
  const plannedImport = cs.plannedIds?.planImport
  const fileId = plannedImport?.fileId ?? uuidv7()

  const fileEvent: RawEvent<'file.create'> = {
    id: plannedImport?.fileEventId ?? uuidv7(),
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
  cmd.cells.forEach((cell, i) => {
    const planned = plannedImport?.cells[i]
    const cellId = planned?.cellId ?? cell.id ?? uuidv7()
    cellEvents.push({
      id: planned?.eventId ?? uuidv7(),
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
  })

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

  // Mark committed regardless of partial rejects. W1-B: event + file ids are now
  // minted at prepare and stored, so a crash-retry (status='committing') re-posts
  // IDENTICAL ids that the /events layer dedupes — no duplicate file. A partial
  // apply is still reported as job_failed with the accurate receipt; re-committing
  // a 'committing' changeset re-drives the same ids and converges.
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

/**
 * Compile a LinkMedia changeset into cell.audio.attach + cell.audio.select
 * events (Agent API v1.1 §3), routed through the SAME /events perimeter as
 * SetTranslation (cell.audio.* requires CONTRIBUTOR — an observer credential is
 * 403'd there), then stamp provenance and write the receipt.
 *
 * The uploaded audio bytes were stored (at artifact upload) in the audio R2
 * layout keyed by the artifactId; here we copy them under the TARGET cell's
 * file, because the app's native /audio playback route derives the fetch key
 * from the cell's file. The attach/select event ids are the prepare-time ids
 * (§4), so a crash-retry (status='committing') re-posts identical ids the
 * /events idempotency layer dedupes — no double-attach — and re-copies the
 * same bytes to the same key (idempotent).
 */
async function commitLinkMedia(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmds: LinkMediaCommand[],
  confirmationId: string | null,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<Response> {
  if (!env.SNAPSHOTS) return errorResponse('job_failed', 'SNAPSHOTS bucket not configured')
  const projectId = cs.projectId
  const clientTs = Date.now()

  // Prepare-time attach/select ids (§4), keyed by (fileId, cellId, artifactId).
  // Fall back to minting for changesets staged before the linkMedia ledger.
  const plannedByKey = new Map(
    (cs.plannedIds?.linkMedia ?? []).map((p) => [
      `${cellKey(p.fileId, p.cellId)} ${p.artifactId}`,
      p,
    ]),
  )

  const eventsByFile = new Map<string, RawEvent[]>()
  const allEventIds: string[] = []

  for (const cmd of cmds) {
    // Re-check the artifact: still present, still audio, same project.
    const artifact = await db
      .prepare(
        `SELECT id, kind, r2_key, audio_id, content_type
           FROM artifacts WHERE id::text = ? AND project_id = ?`,
      )
      .bind(cmd.artifactId, projectId)
      .first<{ id: string; kind: string; r2_key: string; audio_id: string | null; content_type: string | null }>()
    if (!artifact || artifact.kind !== 'audio' || !artifact.audio_id) {
      await db.prepare(`UPDATE changesets SET status = 'stale' WHERE id = ?`).bind(cs.id).run()
      return errorResponse(
        'plan_stale',
        `artifact ${cmd.artifactId} is no longer an audio artifact in this project`,
      )
    }

    // Re-check the target cell still exists.
    const cellStates = await resolveCellStates(db, projectId, [cmd])
    const s = cellStates.get(cellKey(cmd.fileId, cmd.cellId))
    if (!s || (!s.sourceExists && !s.targetExists)) {
      await db.prepare(`UPDATE changesets SET status = 'stale' WHERE id = ?`).bind(cs.id).run()
      return errorResponse(
        'plan_stale',
        `cell ${cmd.cellId} in file ${cmd.fileId} no longer exists`,
      )
    }

    // Copy the uploaded bytes under the target cell's file so the app's native
    // /audio route (keyed by the cell's file) serves them. Idempotent on retry.
    const src = await env.SNAPSHOTS.get(artifact.r2_key)
    if (!src) {
      await db.prepare(`UPDATE changesets SET status = 'stale' WHERE id = ?`).bind(cs.id).run()
      return errorResponse('plan_stale', `artifact ${cmd.artifactId} bytes missing from storage`)
    }
    const destKey = audioObjectKey(env, projectId, cmd.fileId, artifact.audio_id)
    await env.SNAPSHOTS.put(destKey, await src.arrayBuffer(), {
      httpMetadata: artifact.content_type ? { contentType: artifact.content_type } : undefined,
    })

    const planned = plannedByKey.get(`${cellKey(cmd.fileId, cmd.cellId)} ${cmd.artifactId}`)
    const attachId = planned?.attachEventId ?? uuidv7()
    const selectId = planned?.selectEventId ?? uuidv7()
    const url = `frontier-audio://${artifact.audio_id}`

    const attachEvent: RawEvent<'cell.audio.attach'> = {
      id: attachId,
      schemaVersion: 1,
      kind: 'cell.audio.attach',
      projectId,
      fileId: cmd.fileId,
      cellId: cmd.cellId,
      parentId: null,
      author: cred.username,
      payload: {
        audioId: artifact.audio_id,
        url,
        slot: 'recording',
        ...(artifact.content_type ? { mimeType: artifact.content_type } : {}),
      },
      clientTs,
    }
    const selectEvent: RawEvent<'cell.audio.select'> = {
      id: selectId,
      schemaVersion: 1,
      kind: 'cell.audio.select',
      projectId,
      fileId: cmd.fileId,
      cellId: cmd.cellId,
      parentId: null,
      author: cred.username,
      payload: { audioId: artifact.audio_id, slot: 'recording' },
      clientTs,
    }
    // attach must precede select in the batch so the projection sees the row
    // before the select re-affirms it.
    allEventIds.push(attachId, selectId)
    const list = eventsByFile.get(cmd.fileId)
    if (list) list.push(attachEvent, selectEvent)
    else eventsByFile.set(cmd.fileId, [attachEvent, selectEvent])
  }

  // Route each file's events through the /events perimeter.
  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
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
  }

  // Nothing applied but events were rejected — surface the reason (an observer
  // credential is 403'd by the perimeter since cell.audio.* needs CONTRIBUTOR).
  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  // Stamp the server-verified provenance envelope on applied events.
  const provenance = buildProvenance(request, cs, confirmationId)
  const appliedIds = allEventIds.filter((eid) => acceptedIds.has(eid))
  if (appliedIds.length > 0) {
    const placeholders = appliedIds.map(() => '?').join(', ')
    await db
      .prepare(`UPDATE events SET provenance = ?::jsonb WHERE id IN (${placeholders})`)
      .bind(JSON.stringify(provenance), ...appliedIds)
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
  }

  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, cs.id)
    .run()

  if (rejected.length > 0) {
    return errorResponse('job_failed', 'link-media partially failed — some events were rejected', {
      receipt,
    })
  }

  return Response.json({ receipt })
}
