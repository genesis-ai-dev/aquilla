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
import { cellKey, type Command } from './commands'
import { resolveCellStates } from './preconditions'
import { loadChangeset } from './store'
import { mintInternalSyncToken } from './token-bridge'
import { uuidv7 } from './uuid'
import { handleEventsWriteRequest } from '../events/route'
import type { RawEvent } from '../events/types'
import type { ChangesetReceipt, ChangesetWarning, ExternalEnv } from './types'
// SWARM-TODO: after W1-A merges, switch to `db/shared/api-credentials`.
import { validateApiCredential } from './__stubs__/api-credentials'

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

  const cred = await validateApiCredential(db, bearer(request))
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

  // ── Compile commands → target.cell.commit events, grouped by file ─────────
  const commandByCell = new Map<string, Command>()
  for (const c of cs.commands) commandByCell.set(cellKey(c.fileId, c.cellId), c)

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
    channel: 'rest',
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
