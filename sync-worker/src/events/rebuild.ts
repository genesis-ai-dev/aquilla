// Projection rebuild endpoint.
//
// POST /admin/projects/:projectId/rebuild-projection
//
// Drops every cell row + cell_validators row for this project, then replays
// every event in `server_seq` order, applying the AD-2 first-child-of-
// parent rule. The naive linear replay is enough here: each event has at
// most one preceding sibling at its `(project_id, file_id, cell_id,
// parent_id)` slot, and we visit in seq order, so a sibling that arrived
// LATER (higher seq) and lost the race never gets to update the projection.
//
// Replay == live (RACE-2 / M1-2): the live path's chain_claims arbitration
// always awards a contested slot to the LOWEST-server_seq sibling (the
// per-project seq counter's row lock makes commit order == seq order, and
// the claim is taken inside that critical section — see chain-claims.ts).
// That is exactly the first-in-seq-order rule applied here, so a rebuild
// reproduces the live projection byte-for-byte. chain_claims itself is NOT
// rewritten by rebuild: it was populated under the same rule, and historical
// slots without claim rows are still guarded by the isWinningChild pre-check
// against `events`.
//
// ── Non-atomic failure mode ────────────────────────────────────────────
// As before — DELETE + replay is not wrapped in a transaction. Re-running
// the endpoint after a partial failure restarts from a clean slate.

import {
  buildEventProjectionStmts,
  CHAIN_MUTATING_KINDS,
  type PersistedEvent,
} from './event-projection'
import type { EventKind } from './types'

const BATCH_LIMIT = 100

export interface RebuildEnv {
  AQUILLA_PG?: AquillaDb
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
  if (auth !== `Bearer ${env.SYNC_SECRET_KEY}`) {
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

  // 3. AD-2 first-child-of-parent in-memory tracking.
  //    For each `(project_id, file_id, cell_id, parent_id)` we record the
  //    id of the first event we saw at that slot — that one wins. Subsequent
  //    siblings stay in `events` (which we're not rewriting) but don't
  //    contribute to the projection.
  const winningChildAt = new Map<string, string>()
  const childKey = (row: EventRow): string =>
    `${row.project_id}\0${row.file_id ?? ''}\0${row.cell_id ?? ''}\0${row.parent_id ?? '<null>'}`

  const stmts: AquillaStatement[] = []
  let eventsRead = 0
  let eventsProjected = 0

  for (const row of eventRows) {
    eventsRead += 1

    // Strict AD-2 first-child-of-parent for every chain-mutating event,
    // commits included (must match route.ts). We replay in server_seq ASC,
    // so the first event at a given (project, file, cell, parent_id) slot
    // is the winner; siblings stay in `events` (we're not rewriting the log)
    // but do not contribute to the projection. The guard applies ONLY to
    // chain-mutating kinds — cell.validate (parent_id NULL) would otherwise
    // collide with source.cell.create at the same slot and be dropped.
    let isWinner = true
    if (row.cell_id && CHAIN_MUTATING_KINDS.has(row.kind)) {
      const key = childKey(row)
      const winner = winningChildAt.get(key)
      if (!winner) {
        winningChildAt.set(key, row.id)
      } else if (winner !== row.id) {
        isWinner = false
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

  // 5. Counts.
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
    startedAt,
    completedAt,
    note: 'Rebuild is not atomic; if the worker died mid-rebuild, projection rows may be incomplete. Re-run this endpoint to recover.',
  })
}
