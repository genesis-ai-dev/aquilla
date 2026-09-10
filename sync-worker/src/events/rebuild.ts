// Projection rebuild endpoint.
//
// POST /admin/projects/:projectId/rebuild-projection
//
// Drops every cell row + cell_validators row for this project, then replays
// every event in `server_seq` order, applying the head compare-and-swap rule
// (AQU-1154, invariant I1): walking the log in seq order, a chain-arbitrated
// event applies iff its parent_id IS the cell's head (per side/lane) at that
// point, or the row does not exist yet. That is exactly what the live path's
// gated cells write enforces inside its transaction (commit order == seq
// order under the per-project seq lock), so a rebuild reproduces the live
// projection. chain_claims itself is NOT rewritten by rebuild.
//
// ── Non-atomic failure mode ────────────────────────────────────────────
// As before — DELETE + replay is not wrapped in a transaction. Re-running
// the endpoint after a partial failure restarts from a clean slate.

import {
  buildEventProjectionStmts,
  isChainArbitrated,
  isChainMutatingKind,
  laneOfEvent,
  type PersistedEvent,
} from './event-projection'
import type { EventKind } from './types'
import { fullProgressRecomputeStmts } from './progress-projection'
import { isAuthorizedAdminBearer } from '../lib/admin-auth'

const BATCH_LIMIT = 100

export interface RebuildEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  parent_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
  server_seq: number
}

const REBUILD_PATH = /^\/admin\/projects\/([^/]+)\/rebuild-projection$/

export async function handleRebuildProjectionRequest(
  request: Request,
  env: RebuildEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = REBUILD_PATH.exec(url.pathname)
  if (!match) return null

  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  const auth = request.headers.get('Authorization') ?? ''
  if (!isAuthorizedAdminBearer(auth, env)) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  const db = env.AQUILLA_PG
  const projectId = decodeURIComponent(match[1])
  const startedAt = Date.now()

  // 1. Wipe the projection for this project.
  const deleteStmts: AquillaStatement[] = [
    db.prepare('DELETE FROM file_section_progress WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM cell_validators WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM cells WHERE project_id = ?').bind(projectId),
  ]
  await db.batch(deleteStmts)

  // 2. Load events in server_seq order.
  const { results: eventRows } = await db
    .prepare(
      `SELECT id, schema_version, project_id, file_id, cell_id, parent_id, kind,
              author, payload, client_ts, server_ts, server_seq
       FROM events WHERE project_id = ?
       ORDER BY server_seq ASC, server_ts ASC, id ASC`,
    )
    .bind(projectId)
    .all<EventRow>()

  if (!eventRows) {
    return new Response('failed to read events from DB', { status: 500 })
  }

  // 3. Head compare-and-swap in-memory tracking: the current chain head per
  //    (project, file, cell, side, lane) — the same row key `cells` uses.
  //    Source and target sides, plus named target lanes, each have their own
  //    head. A delete clears the head (the row is gone; the next event on
  //    that key applies regardless of parent, exactly as the live INSERT
  //    path does). `source.cell.mirror` is not chain-arbitrated but DOES
  //    move the source head (under its monotonic upstream_seq guard), so a
  //    later source event chained on a mirror id must see it as the head.
  const headAt = new Map<string, string>()
  const mirrorSeqAt = new Map<string, number>()
  const parsedPayload = (row: EventRow): unknown => {
    try {
      return JSON.parse(row.payload)
    } catch {
      return null
    }
  }
  const headKey = (row: EventRow, payload: unknown): string => {
    const side = row.kind.startsWith('source.') ? 'source' : 'target'
    return `${row.project_id}\0${row.file_id ?? ''}\0${row.cell_id ?? ''}\0${side}\0${laneOfEvent(row.kind, payload)}`
  }

  const stmts: AquillaStatement[] = []
  let eventsRead = 0
  let eventsProjected = 0

  // Kinds whose projection is built OUTSIDE buildEventProjectionStmts (it
  // throws for them by design): assignment.* land in the assignments table
  // via handleAssignmentEvent and project.link-source is handled in
  // dispatch.ts — neither targets the tables this rebuild wipes
  // (cells / cell_validators / file_section_progress), so their live
  // projection is intact and they are simply skipped during replay. Without
  // this, one assignment event anywhere in the log aborted the whole rebuild
  // MID-REPLAY, stranding the project on a partially rebuilt projection.
  const DELEGATED_PROJECTION_KINDS = new Set<string>([
    'assignment.create',
    'assignment.reassign',
    'assignment.unassign',
    'project.link-source',
  ])

  for (const row of eventRows) {
    eventsRead += 1
    if (DELEGATED_PROJECTION_KINDS.has(row.kind)) continue

    // Head compare-and-swap for every chain-arbitrated event (must match the
    // live gate in event-projection.ts): it applies iff its parent_id is the
    // current head for its side/lane, or there is no row yet. Stale branches
    // stay in `events` (we're not rewriting the log) but do not contribute to
    // the projection. The guard applies ONLY to chain-arbitrated kinds —
    // cell.validate (parent_id NULL) is not a chain step, and a parent-null
    // cell DELETE (a migration retraction, AQU-747/910) is a tombstone that
    // applies unconditionally (AQU-931).
    let isWinner = true
    if (row.cell_id && isChainMutatingKind(row.kind)) {
      const key = headKey(row, parsedPayload(row))
      if (isChainArbitrated(row.kind, row.parent_id)) {
        const head = headAt.get(key)
        isWinner = head === undefined || head === row.parent_id
      }
      if (isWinner) {
        if (row.kind.endsWith('.delete')) headAt.delete(key)
        else headAt.set(key, row.id)
      }
    } else if (row.kind === 'source.cell.mirror' && row.cell_id) {
      const payload = parsedPayload(row) as { upstream?: { seq?: number } } | null
      const seq = payload?.upstream?.seq
      const key = headKey(row, payload)
      const last = mirrorSeqAt.get(key)
      if (typeof seq === 'number' && (last === undefined || seq > last)) {
        mirrorSeqAt.set(key, seq)
        headAt.set(key, row.id)
      }
    }

    if (!isWinner) continue

    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch (err) {
      return new Response(
        `failed to parse payload for event ${row.id}: ${String(err)}`,
        { status: 500 },
      )
    }

    const event: PersistedEvent = {
      id: row.id,
      schemaVersion: row.schema_version,
      projectId: row.project_id,
      fileId: row.file_id,
      cellId: row.cell_id,
      parentId: row.parent_id,
      kind: row.kind as EventKind,
      author: row.author,
      payload,
      clientTs: row.client_ts,
      serverTs: row.server_ts,
      serverSeq: row.server_seq,
    }

    try {
      // Defer the O(N²) per-cell file-counter recompute; do it once, set-based,
      // after the replay (step 4b) — the 67%-of-time fix, now in the rebuild.
      buildEventProjectionStmts(db, event, stmts, { deferFileCounters: true })
      eventsProjected += 1
    } catch (err) {
      return new Response(
        `failed to build projection for event ${row.id} (kind: ${row.kind}): ${String(err)}`,
        { status: 500 },
      )
    }
  }

  const statementsApplied = stmts.length

  // 4. Apply in batch chunks.
  for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
    await db.batch(stmts.slice(i, i + BATCH_LIMIT))
  }

  // 4b. Recompute file counters once, set-based (deferred above). Mirrors
  //     POST /migrate/finalize — O(total cells), not O(N²) per cell.
  await db
    .prepare(
      `UPDATE files SET
         cell_count = (SELECT COUNT(DISTINCT cell_id) FROM cells WHERE project_id=files.project_id AND file_id=files.id),
         approved_count = (SELECT COUNT(*) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND validated=1),
         filled_count = (SELECT COUNT(*) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND side='target' AND TRIM(value)!=''),
         word_count = (SELECT COALESCE(SUM(word_count),0) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND side='target'),
         last_edit_at = (SELECT MAX(last_edit_at) FROM cells WHERE project_id=files.project_id AND file_id=files.id),
         updated_at = ?
       WHERE project_id = ?`,
    )
    .bind(Date.now(), projectId)
    .run()

  // 5. Mark the rebuild for warm delta clients (audit B5). A rebuild changes
  //    projection rows without minting events, so MAX(server_seq) — the
  //    GET /cells delta + ETag watermark — does not move and every warm
  //    client's `?since=` would return an empty delta (and If-None-Match
  //    would 304) forever, pinning pre-rebuild values in the client's
  //    persistent IDB cache. Allocate one seq through the same per-project
  //    counter the live path uses (event-insert.ts; same seeding, same
  //    GREATEST self-heal) and record it as rebuilt_seq: the read route
  //    resyncs any cursor below it and folds it into the ETag.
  //
  //    Allocating — rather than copying last_seq — makes the marker STRICTLY
  //    greater than every cursor a client could hold pre-rebuild, so even a
  //    fully caught-up client (since == MAX(server_seq) == last_seq) trips
  //    the `since < rebuilt_seq` resync. The consumed seq is a harmless gap,
  //    exactly like an idempotent replay's.
  const rebuiltSeqRaw = await db
    .prepare(
      `INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq)
       SELECT ?, seed.next_seq, seed.next_seq
       FROM (SELECT COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1 AS next_seq) seed
       ON CONFLICT (project_id) DO UPDATE SET
         last_seq    = GREATEST(project_seq_counters.last_seq + 1, excluded.last_seq),
         rebuilt_seq = GREATEST(project_seq_counters.last_seq + 1, excluded.last_seq)
       RETURNING last_seq`,
    )
    .bind(projectId, projectId)
    .first<number | string | bigint>('last_seq')
  const rebuiltSeq = Number(rebuiltSeqRaw ?? 0)

  const { results: files } = await db
    .prepare('SELECT id FROM files WHERE project_id = ?')
    .bind(projectId)
    .all<{ id: string }>()
  for (const file of files) {
    await db.batch(fullProgressRecomputeStmts(db, projectId, file.id, Date.now()))
  }

  // 6. Counts.
  const [cellsResult, validatorsResult] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) as cnt FROM cells WHERE project_id = ?')
      .bind(projectId)
      .first<{ cnt: number }>(),
    db
      .prepare('SELECT COUNT(*) as cnt FROM cell_validators WHERE project_id = ?')
      .bind(projectId)
      .first<{ cnt: number }>(),
  ])

  const completedAt = Date.now()

  return Response.json({
    ok: true,
    eventsRead,
    eventsProjected,
    statementsApplied,
    cellsAfter: cellsResult?.cnt ?? 0,
    validatorsAfter: validatorsResult?.cnt ?? 0,
    rebuiltSeq,
    startedAt,
    completedAt,
    note: 'Rebuild is not atomic; if the worker died mid-rebuild, projection rows may be incomplete. Re-run this endpoint to recover.',
  })
}
