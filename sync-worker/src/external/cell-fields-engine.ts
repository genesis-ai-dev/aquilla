// Cell-field prepare/commit engine (AQU-1183).
//
// Prepare resolves live state — the SOURCE chain head for every source-side
// write (stored as a standard CellPrecondition so the shared commit drift gate
// re-checks it), cell/file existence for everything the plan touches — mirrors
// the two DYNAMIC authority gates the /events perimeter applies to these kinds
// (the project timing lock, `allowTrackEditing`), and stages a normalized plan
// with prepare-time event ids. Commit re-checks existence (first attempt only:
// a crash-retry re-posts the SAME ids and the /events idempotency layer absorbs
// them), compiles RawEvents, and routes them through the /events perimeter
// exactly like SetTranslation — the perimeter re-authorizes roles, membership,
// scopes and both dynamic gates as the backstop.

import { errorResponse, toErrorResponse } from './errors'
import {
  planCellFields,
  type CellFieldCommand,
  type CellFieldPlan,
} from './commands-cell-fields'
import { cellKey, laneCellKey } from './cell-keys'
import { resolveCellStates, type CellPrecondition } from './preconditions'
import {
  buildProvenance,
  markChangesetStale,
  stampProvenance,
  writeCommittedReceipt,
  type EventsWriteResponse,
} from './commit-gates'
import { stageAndRespond } from './stage'
import { mintInternalSyncToken } from './token-bridge'
import { uuidv7 } from './uuid'
import { handleEventsWriteRequest } from '../events/route'
import { ROLE, roleLabel } from '../events/role-policy'
import { isUserInsertedCell, resolveTimingLocked } from '../events/timing-authority'
import { isGatedTrackPatch, resolveAllowTrackEditing } from '../events/track-editing-authority'
import type { RawEvent } from '../events/types'
import type {
  ChangesetReceipt,
  ChangesetSummary,
  ChangesetWarning,
  ExternalEnv,
  PlannedCellFieldIds,
  ProvenanceChannel,
  StoredChangeset,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'

/** Statements per POST to the /events perimeter (mirrors EMIT_CHUNK). */
const CELL_FIELDS_CHUNK = 100

interface FileRow {
  id: string
  deleted_at: number | null
}

/** Batch-load the files a plan targets, keyed by id. */
async function loadFiles(
  db: AquillaDb,
  projectId: string,
  fileIds: readonly string[],
): Promise<Map<string, FileRow>> {
  const out = new Map<string, FileRow>()
  if (fileIds.length === 0) return out
  const placeholders = fileIds.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT id, deleted_at FROM files WHERE project_id = ? AND id IN (${placeholders})`)
    .bind(projectId, ...fileIds)
    .all<FileRow>()
  for (const row of results) out.set(row.id, row)
  return out
}

/** Every (fileId, cellId) and fileId a normalized plan references. */
function collectRefs(plan: CellFieldPlan) {
  const cellRefs: { fileId: string; cellId: string }[] = []
  const seenCells = new Set<string>()
  const fileIds = new Set<string>()
  const addCell = (fileId: string, cellId: string): void => {
    fileIds.add(fileId)
    const key = cellKey(fileId, cellId)
    if (seenCells.has(key)) return
    seenCells.add(key)
    cellRefs.push({ fileId, cellId })
  }
  for (const s of plan.sourceCommits) addCell(s.fileId, s.cellId)
  for (const r of plan.retimes) addCell(r.fileId, r.cellId)
  for (const t of plan.timingModes) fileIds.add(t.fileId)
  for (const t of plan.trackOverrides) fileIds.add(t.fileId)
  return { cellRefs, fileIds: [...fileIds] }
}

/** Mint the prepare-time id ledger for a normalized plan (§4). */
function mintPlannedIds(plan: CellFieldPlan): PlannedCellFieldIds {
  return {
    sourceCommits: plan.sourceCommits.map((s) => ({
      fileId: s.fileId,
      cellId: s.cellId,
      eventId: uuidv7(),
    })),
    retimes: plan.retimes.map((r) => ({ fileId: r.fileId, cellId: r.cellId, eventId: uuidv7() })),
    timingModes: plan.timingModes.map((t) => ({ fileId: t.fileId, eventId: uuidv7() })),
    trackOverrides: plan.trackOverrides.map((t) => ({
      fileId: t.fileId,
      trackId: t.trackId,
      eventId: uuidv7(),
    })),
  }
}

/** Server-computed effect summary for a cell-field changeset. */
function summarize(plan: CellFieldPlan, warnings: ChangesetWarning[]): ChangesetSummary {
  const summary: ChangesetSummary = { warnings }
  const sourceEdits = plan.sourceCommits.filter((s) => s.value !== undefined).length
  const transcriptions = plan.sourceCommits.filter((s) => s.transcription !== undefined).length
  if (sourceEdits > 0) summary.sourceEdits = sourceEdits
  if (transcriptions > 0) summary.transcriptionsSet = transcriptions
  if (plan.retimes.length > 0) summary.cellsRetimed = plan.retimes.length
  if (plan.timingModes.length > 0) summary.timingModesSet = plan.timingModes.length
  if (plan.trackOverrides.length > 0) summary.trackOverridesSet = plan.trackOverrides.length
  return summary
}

/**
 * Prepare a cell-field changeset (AQU-1183). Every reference is resolved
 * against the live projection and a failure REJECTS the whole plan
 * (validation_failed naming the target) — the EmitEvents doctrine: a batch with
 * silently-skipped items is not an approvable plan.
 *
 * `callerRoleLevel` is the live-resolved role (the static floor already ran in
 * the generic prepare gate); this adds the two DYNAMIC bumps the /events
 * perimeter applies to exactly these kinds, so a plan the caller could never
 * commit is denied here rather than staged with its effect summary leaked:
 *
 *   - the project TIMING LOCK raises `cell.retime` to MAINTAINER, except on a
 *     line a person added by hand (timing-authority.ts);
 *   - `allowTrackEditing` gates restructuring `file.track.set` patches at every
 *     clearance, OWNER included — it answers *whether*, not *who*
 *     (track-editing-authority.ts).
 */
export async function prepareCellFields(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmds: readonly CellFieldCommand[],
  env: ExternalEnv,
  callerRoleLevel: number,
): Promise<Response> {
  const plan = planCellFields(cmds)
  const refs = collectRefs(plan)
  const [states, files] = await Promise.all([
    resolveCellStates(db, projectId, refs.cellRefs),
    loadFiles(db, projectId, refs.fileIds),
  ])

  for (const fileId of refs.fileIds) {
    const f = files.get(fileId)
    if (!f) return errorResponse('validation_failed', `file ${fileId} does not exist`)
    if (f.deleted_at != null) return errorResponse('validation_failed', `file ${fileId} is deleted`)
  }

  // Source-side writes chain on the cell's CURRENT source head — pin it as a
  // standard precondition so the shared commit drift gate re-checks it and
  // returns plan_stale if someone edited the source between prepare and commit.
  const preconditions: CellPrecondition[] = []
  for (const s of plan.sourceCommits) {
    const live = states.get(laneCellKey(s.fileId, s.cellId))
    if (!live || !live.sourceExists || live.sourceEventId == null) {
      return errorResponse(
        'validation_failed',
        `cell ${s.cellId} in file ${s.fileId} has no source row to edit`,
      )
    }
    preconditions.push({
      fileId: s.fileId,
      cellId: s.cellId,
      targetHeadEventId: live.targetHeadEventId,
      sourceEventId: live.sourceEventId,
    })
  }

  // Retimes only need the cell to exist — `cell.retime` is non-chain-mutating,
  // so it carries parentId: null and competes for no chain slot.
  for (const r of plan.retimes) {
    const live = states.get(laneCellKey(r.fileId, r.cellId))
    if (!live || (!live.sourceExists && !live.targetExists)) {
      return errorResponse(
        'validation_failed',
        `cell ${r.cellId} in file ${r.fileId} does not exist`,
      )
    }
  }

  // Dynamic gate 1 — the project timing lock (fail-safe LOCKED).
  if (plan.retimes.length > 0 && callerRoleLevel < ROLE.MAINTAINER) {
    if (await resolveTimingLocked(db, projectId)) {
      for (const r of plan.retimes) {
        if (!(await isUserInsertedCell(db, projectId, r.fileId, r.cellId))) {
          return errorResponse(
            'permission_denied',
            `timing is locked for this project — retiming cell ${r.cellId} requires ${roleLabel(ROLE.MAINTAINER)} (${ROLE.MAINTAINER})`,
          )
        }
      }
    }
  }

  // Dynamic gate 2 — `allowTrackEditing`. No role term, deliberately: two gates
  // means two gates, and an OWNER is refused too while the project is opted out.
  const gatedTrackWrites = plan.trackOverrides.filter((t) => isGatedTrackPatch({ patch: t.patch }))
  if (gatedTrackWrites.length > 0 && !(await resolveAllowTrackEditing(db, projectId))) {
    return errorResponse(
      'permission_denied',
      'timeline track editing is not enabled for this project — enable allowTrackEditing in project settings first',
    )
  }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [...cmds],
    preconditions,
    summary: summarize(plan, plan.warnings),
    plannedIds: { cellFields: mintPlannedIds(plan) },
  })
}

/**
 * Commit a cell-field changeset. The shared first-attempt gates (expiry,
 * ask-mode confirmation, source/target head drift over the stored
 * preconditions) already ran in the commit core; this re-checks existence
 * (first attempt only — a crash-retry's own partial apply legitimately changed
 * that state), compiles, routes through the perimeter, stamps provenance, and
 * writes the receipt. Per-event perimeter rejections surface as receipt
 * warnings (SetTranslation parity); an all-rejected batch fails with the
 * perimeter's own reason.
 */
export async function commitCellFields(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmds: readonly CellFieldCommand[],
  confirmationId: string | null,
  channel: ProvenanceChannel,
  wasStaged: boolean,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<Response> {
  const projectId = cs.projectId
  // Re-derived from the STORED commands by the same pure normalizer prepare
  // used, so the plan and its id ledger line up index-for-index on a retry.
  const plan = planCellFields(cmds)

  if (wasStaged) {
    const refs = collectRefs(plan)
    const [states, files] = await Promise.all([
      resolveCellStates(db, projectId, refs.cellRefs),
      loadFiles(db, projectId, refs.fileIds),
    ])
    const stale = async (message: string): Promise<Response> => {
      await markChangesetStale(db, cs.id)
      return errorResponse('plan_stale', message)
    }
    for (const fileId of refs.fileIds) {
      const f = files.get(fileId)
      if (!f) return stale(`file ${fileId} no longer exists`)
      if (f.deleted_at != null) return stale(`file ${fileId} was deleted since prepare`)
    }
    for (const ref of refs.cellRefs) {
      const live = states.get(laneCellKey(ref.fileId, ref.cellId))
      if (!live || (!live.sourceExists && !live.targetExists)) {
        return stale(`cell ${ref.cellId} in file ${ref.fileId} no longer exists`)
      }
    }
  }

  // ── Compile with prepare-time ids + the pinned source heads ───────────────
  const pins = new Map(cs.preconditions.map((p) => [cellKey(p.fileId, p.cellId), p]))
  const planned = cs.plannedIds?.cellFields
  const clientTs = Date.now()
  const eventsByFile = new Map<string, RawEvent[]>()
  const allEventIds: string[] = []

  const push = (fileId: string, event: RawEvent): void => {
    allEventIds.push(event.id)
    const list = eventsByFile.get(fileId)
    if (list) list.push(event)
    else eventsByFile.set(fileId, [event])
  }

  for (const [i, s] of plan.sourceCommits.entries()) {
    const pin = pins.get(cellKey(s.fileId, s.cellId))
    if (!pin?.sourceEventId) {
      return errorResponse(
        'job_failed',
        `stored plan is missing the source pin for cell ${s.cellId} in file ${s.fileId}`,
      )
    }
    push(s.fileId, {
      id: planned?.sourceCommits?.[i]?.eventId ?? uuidv7(),
      schemaVersion: 1,
      kind: 'source.cell.commit',
      projectId,
      fileId: s.fileId,
      cellId: s.cellId,
      // Chain-mutating (AD-2): the parent IS the pinned head, so a source edge
      // that moved under us loses the compare-and-swap instead of clobbering.
      parentId: pin.sourceEventId,
      author: cred.username,
      payload: {
        ...(s.value !== undefined ? { value: s.value } : {}),
        ...(s.valueHtml !== undefined ? { valueHtml: s.valueHtml } : {}),
        ...(s.transcription !== undefined ? { transcription: s.transcription } : {}),
      },
      clientTs,
    } as RawEvent<'source.cell.commit'>)
  }

  for (const [i, r] of plan.retimes.entries()) {
    push(r.fileId, {
      id: planned?.retimes?.[i]?.eventId ?? uuidv7(),
      schemaVersion: 1,
      kind: 'cell.retime',
      projectId,
      fileId: r.fileId,
      cellId: r.cellId,
      parentId: null,
      author: cred.username,
      payload: { startMs: r.startMs, endMs: r.endMs },
      clientTs,
    } as RawEvent<'cell.retime'>)
  }

  for (const [i, t] of plan.timingModes.entries()) {
    push(t.fileId, {
      id: planned?.timingModes?.[i]?.eventId ?? uuidv7(),
      schemaVersion: 1,
      kind: 'file.timing.set',
      projectId,
      fileId: t.fileId,
      parentId: null,
      author: cred.username,
      payload: { timingMode: t.timingMode },
      clientTs,
    } as RawEvent<'file.timing.set'>)
  }

  for (const [i, t] of plan.trackOverrides.entries()) {
    push(t.fileId, {
      id: planned?.trackOverrides?.[i]?.eventId ?? uuidv7(),
      schemaVersion: 1,
      kind: 'file.track.set',
      projectId,
      fileId: t.fileId,
      parentId: null,
      author: cred.username,
      payload: { trackId: t.trackId, patch: t.patch },
      clientTs,
    } as RawEvent<'file.track.set'>)
  }

  // ── Route through the /events perimeter, one token per file ──────────────
  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
  for (const [fileId, events] of eventsByFile) {
    let token: string
    try {
      token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
    } catch (err) {
      return toErrorResponse(err)
    }
    for (let i = 0; i < events.length; i += CELL_FIELDS_CHUNK) {
      const chunk = events.slice(i, i + CELL_FIELDS_CHUNK)
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
  }

  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  const provenance = buildProvenance(request, cs, confirmationId, channel)
  const appliedIds = allEventIds.filter((eid) => acceptedIds.has(eid))
  await stampProvenance(db, provenance, appliedIds)

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
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)

  if (rejected.length > 0) {
    return errorResponse('job_failed', 'cell-field write partially failed — some events were rejected', {
      receipt,
    })
  }
  return Response.json({ receipt })
}
