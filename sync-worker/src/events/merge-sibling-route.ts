// AQU-538 slice 4: opt-in sibling-project merge fold (server side).
//
//   POST /api/v1/projects/:hostId/merge-sibling   { donorProjectId, lane }
//
// The merge tool folds a legacy single-pair "sibling" project (the donor)
// into a host project as one additional target-language LANE. It is the
// front-door analogue of the mirror engine (link-sync.ts): it reads the
// donor's DEFAULT-lane translations and re-emits them as `target.cell.commit
// { targetLang: <lane> }` events on the HOST through the SAME event insert +
// projection path a translator's first commit takes — so lane-qualified chain
// slots (slice 1) let the new lane coexist beside the host's existing lanes
// without competing for a chain slot.
//
// Match key: the shared `cell_id`. A donor cell whose id also exists on the
// host's SOURCE side becomes a host lane commit chained on the host source
// row's event_id (a first commit on a fresh lane chains on the source head,
// exactly like a translator's first commit); a donor cell with no matching
// host source row is reported as skipped, never guessed (design decision 7).
//
// Deterministic event ids (reusing link-sync.ts's uuid-from-hash helper keyed
// on host project + donor event + lane) make a re-run idempotent: the events
// PK ON CONFLICT drops the duplicate insert and the projection UPSERT re-writes
// the same value, so the final cells state is unchanged and no event doubles.
//
// This module never touches the donor's rows and never touches the host's
// default lane — it only ever INSERTs the new lane's target rows.

import { verifyTokenForProject } from '../auth'
import {
  buildEventProjectionStmts,
  fileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import { buildBulkEventInsertStmt, allocateSeqRange, type SeqEventInsertRow } from './event-insert'
import { deterministicMirrorEventId } from './link-sync'
import { fullProgressRecomputeStmts } from './progress-projection'
import type { EventPayloads } from './types'

const BATCH_LIMIT = 100
const MERGE_AUTHOR = 'merge-sibling'
const MERGE_SCHEMA_VERSION = 1

export interface MergeSkip {
  cellId: string
  preview: string
}

export interface MergeSiblingResult {
  merged: number
  skipped: MergeSkip[]
  lane: string
}

/**
 * Deterministic id for a merge commit — reuses link-sync.ts's exported
 * uuid-from-hash helper (deterministicMirrorEventId) with a `merge:<lane>:`
 * prefix on the donor event id so the key covers host project + donor row +
 * lane. Stable across re-runs so replays dedupe via the events PK.
 */
export function deterministicMergeEventId(
  hostProjectId: string,
  donorEventId: string,
  lane: string,
): string {
  return deterministicMirrorEventId(hostProjectId, `merge:${lane}:${donorEventId}`)
}

interface DonorTargetRow {
  file_id: string
  cell_id: string
  value: string
  value_html: string | null
  event_id: string
}

interface HostSourceRow {
  file_id: string
  cell_id: string
  event_id: string
}

/**
 * Fold the donor's default-lane translations into the host as one new lane.
 * Idempotent + safe to re-run (deterministic ids + PK dedupe + value-stable
 * projection UPSERT). Does not lock anything itself; the auth-worker route is
 * the single caller and single-flights per host by construction (one operator
 * click).
 */
export async function mergeSibling(
  db: AquillaDb,
  args: { hostProjectId: string; donorProjectId: string; lane: string },
): Promise<MergeSiblingResult> {
  const { hostProjectId, donorProjectId, lane } = args

  // Donor DEFAULT-lane target rows (side='target' AND target_lang='') — the
  // translations being folded. Non-default donor lanes are out of scope for
  // v1 (a legacy pair project only ever has the default lane).
  const donorRows =
    (
      await db
        .prepare(
          `SELECT file_id, cell_id, value, value_html, event_id
           FROM cells
           WHERE project_id = ? AND side = 'target' AND target_lang = ''`,
        )
        .bind(donorProjectId)
        .all<DonorTargetRow>()
    ).results ?? []

  // Host SOURCE rows — the shared-cell_id invariant lives here: a donor cell
  // can only fold into the host if the host has a source row with the same
  // cell_id (its file_id + event_id become the new lane commit's file + parent).
  const hostSourceRows =
    (
      await db
        .prepare(
          `SELECT file_id, cell_id, event_id
           FROM cells
           WHERE project_id = ? AND side = 'source'`,
        )
        .bind(hostProjectId)
        .all<HostSourceRow>()
    ).results ?? []

  const hostByCell = new Map<string, { fileId: string; eventId: string }>()
  for (const r of hostSourceRows) {
    // First source row per cell_id wins; the shared-cell_id invariant means
    // cell ids are unique per host anyway.
    if (!hostByCell.has(r.cell_id)) hostByCell.set(r.cell_id, { fileId: r.file_id, eventId: r.event_id })
  }

  const skipped: MergeSkip[] = []
  const eventRows: SeqEventInsertRow[] = []
  const persisted: PersistedEvent[] = []
  const now = Date.now()

  for (const donor of donorRows) {
    const host = hostByCell.get(donor.cell_id)
    if (!host) {
      skipped.push({ cellId: donor.cell_id, preview: (donor.value ?? '').slice(0, 40) })
      continue
    }
    const eventId = deterministicMergeEventId(hostProjectId, donor.event_id, lane)
    const payload: EventPayloads['target.cell.commit'] = {
      value: donor.value ?? '',
      valueHtml: donor.value_html ?? undefined,
      // Lane-qualified: this is the whole point — the fold lands on `lane`,
      // never the host default lane.
      targetLang: lane,
      // AD-9 staleness pin: the merged translation was made against the host's
      // current source head (the parent we chain on).
      sourceEventId: host.eventId,
    }
    const base = {
      id: eventId,
      schemaVersion: MERGE_SCHEMA_VERSION,
      projectId: hostProjectId,
      fileId: host.fileId,
      cellId: donor.cell_id,
      // A first commit on a fresh lane chains on the source head, exactly like
      // a translator's first commit (slice 1 lane-qualified the chain slot).
      parentId: host.eventId,
      kind: 'target.cell.commit' as const,
      author: MERGE_AUTHOR,
      clientTs: now,
      serverTs: now,
    }
    eventRows.push({ ...base, payloadJson: JSON.stringify(payload), serverSeq: 0 })
    persisted.push({ ...base, payload })
  }

  if (eventRows.length === 0) {
    return { merged: 0, skipped, lane }
  }

  // Allocate real server_seqs and commit through the front door (canonical
  // events INSERT + buildEventProjectionStmts — the same projection code the
  // live HTTP path uses). No chainGate: like the mirror engine and rebuild,
  // the fold arbitrates winners itself (each event is the sole first commit on
  // its fresh lane, so there is nothing to compete with).
  const baseSeq = await allocateSeqRange(db, hostProjectId, eventRows.length)
  for (let i = 0; i < eventRows.length; i++) {
    eventRows[i]!.serverSeq = baseSeq + i
    persisted[i]!.serverSeq = baseSeq + i
  }

  const allStmts: AquillaStatement[] = [buildBulkEventInsertStmt(db, eventRows)]
  for (const event of persisted) {
    buildEventProjectionStmts(db, event, allStmts, { deferFileCounters: true })
  }
  for (let i = 0; i < allStmts.length; i += BATCH_LIMIT) {
    await db.batch(allStmts.slice(i, i + BATCH_LIMIT))
  }

  // Recompute file counters + per-lane progress for touched host files
  // (deferFileCounters above skipped the per-event recompute).
  const touchedFiles = new Set<string>()
  for (const p of persisted) if (p.fileId) touchedFiles.add(p.fileId)
  for (const fileId of touchedFiles) {
    await db.batch([
      fileCountersRecomputeStmt(db, hostProjectId, fileId, now),
      ...fullProgressRecomputeStmts(db, hostProjectId, fileId, now),
    ])
  }

  return { merged: eventRows.length, skipped, lane }
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/merge-sibling$/

/** Minimum role to run a merge — project_lead (500)+, checked on the HOST via
 *  the service token minted by auth-worker (which has already verified 500+ on
 *  both host and donor). */
const MERGE_MIN_ROLE = 500

export interface MergeSiblingRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

export async function handleMergeSiblingRequest(
  request: Request,
  env: MergeSiblingRouteEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== 'POST') return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  const hostId = decodeURIComponent(match[1]!)

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    return new Response('missing Authorization header', { status: 401 })
  }
  const auth = await verifyTokenForProject(token, hostId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })
  if (auth.claims.role < MERGE_MIN_ROLE) {
    return new Response('role >= project_lead (500) required', { status: 403 })
  }

  let body: { donorProjectId?: unknown; lane?: unknown }
  try {
    body = (await request.json()) as { donorProjectId?: unknown; lane?: unknown }
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  const donorProjectId = typeof body.donorProjectId === 'string' ? body.donorProjectId : ''
  const lane = typeof body.lane === 'string' ? body.lane.trim() : ''
  if (!donorProjectId) return new Response('donorProjectId required', { status: 400 })
  if (!lane) return new Response('lane required', { status: 400 })
  if (donorProjectId === hostId) return new Response('donor and host must differ', { status: 400 })

  const result = await mergeSibling(env.AQUILLA_PG, {
    hostProjectId: hostId,
    donorProjectId,
    lane,
  })

  return Response.json({ hostId, ...result })
}
