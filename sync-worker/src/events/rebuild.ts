// Projection rebuild endpoint for codex CQRS Phase 0.
//
// POST /admin/projects/:projectId/rebuild-projection
//
// Auth: Authorization: Bearer ${SYNC_SECRET_KEY}.
//
// Drops every cell row for files in this project AND every cell_validators
// row for this project, then replays all events ORDER BY server_ts ASC,
// applying each via buildEventProjectionStmts. Returns
// {
//   ok: true,
//   eventsRead: N,           -- total rows pulled from events table
//   statementsApplied: M,    -- total D1 statements issued (excludes no-op event kinds)
//   cellsAfter: C,
//   validatorsAfter: V,
//   startedAt: <unix ms>,
//   completedAt: <unix ms>,
//   note: '...',
// }
//
// ── Non-atomic failure mode ────────────────────────────────────────────────────
//
// This rebuild is NOT atomic. The sequence is:
//   1. db.batch([DELETE cell_validators, DELETE cells])
//   2. db.batch() x N  (INSERT statements in D1_BATCH_LIMIT-sized chunks)
//
// If the worker dies between step 1 and the end of step 2, the projection
// tables are left partially empty. Symptoms: cells and/or cell_validators
// rows missing for some files. Recovery: re-run this endpoint. The DELETE
// step wipes whatever is there and a clean replay rebuilds from scratch.
//
// For Phase 1, consider adding a `projection_state` table row that marks
// rebuild_started / rebuild_completed so operators can detect an incomplete run.
//
// ── Fail-fast guarantee ────────────────────────────────────────────────────────
//
// All D1PreparedStatements for every event are built up-front BEFORE any
// db.batch() write call. If any event fails (bad payload, unknown kind, missing
// required field), the function returns 500 without having mutated any rows.

import { buildEventProjectionStmts, type PersistedEvent } from './event-projection'
import type { EventKind } from './types'

// Cloudflare D1 max statements per db.batch() call.
// Exceeding this limit causes D1 to throw at runtime with an unhelpful error.
const D1_BATCH_LIMIT = 100

export interface RebuildEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

// D1 row shape for an event as returned by SELECT *.
interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  author: string
  payload: string   // JSON text -- we parse it below
  client_ts: number
  server_ts: number
}

const REBUILD_PATH = /^\/admin\/projects\/([^/]+)\/rebuild-projection$/

/**
 * POST /admin/projects/:projectId/rebuild-projection
 *
 * Returns null if the URL doesn't match. Caller chains it with handleAdminRequest.
 */
export async function handleRebuildProjectionRequest(
  request: Request,
  env: RebuildEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = REBUILD_PATH.exec(url.pathname)
  if (!match) return null

  // Method check comes AFTER the URL match so an unmatched URL falls through
  // to the next handler (null return above) while a matched-but-wrong-method
  // URL correctly returns 405 (not 404 from the next handler).
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  // Auth: bearer key must match SYNC_SECRET_KEY.
  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  const auth = request.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${env.SYNC_SECRET_KEY}`) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!env.AQUILLA_DB) {
    return new Response('AQUILLA_DB binding not configured', { status: 500 })
  }

  const db = env.AQUILLA_DB
  const projectId = decodeURIComponent(match[1])
  const startedAt = Date.now()

  // 1. Wipe the existing projection for this project.
  // cells doesn't have project_id directly -- join through files.
  const deleteStmts: D1PreparedStatement[] = [
    db.prepare(
      'DELETE FROM cell_validators WHERE project_id = ?',
    ).bind(projectId),
    db.prepare(
      'DELETE FROM cells WHERE file_id IN (SELECT id FROM files WHERE project_id = ?)',
    ).bind(projectId),
  ]
  await db.batch(deleteStmts)

  // 2. Load events in chronological order.
  const { results: eventRows } = await db
    .prepare(
      'SELECT * FROM events WHERE project_id = ? ORDER BY server_ts ASC',
    )
    .bind(projectId)
    .all<EventRow>()

  if (!eventRows) {
    return new Response('failed to read events from DB', { status: 500 })
  }

  // 3. Build ALL projection statements up-front before any mutation.
  //    If any event throws (bad payload, unknown kind, missing field), we
  //    return 500 here -- before step 4 writes anything.
  const stmts: D1PreparedStatement[] = []
  let eventsRead = 0

  for (const row of eventRows) {
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
      kind: row.kind as EventKind,
      author: row.author,
      payload,
      clientTs: row.client_ts,
      serverTs: row.server_ts,
    }

    try {
      buildEventProjectionStmts(db, event, stmts)
    } catch (err) {
      return new Response(
        `failed to build projection for event ${row.id} (kind: ${row.kind}): ${String(err)}`,
        { status: 500 },
      )
    }

    eventsRead += 1
  }

  const statementsApplied = stmts.length

  // 4. Apply all projection statements in D1_BATCH_LIMIT-sized chunks.
  //    D1 caps db.batch() at 100 statements per call; exceeding the cap throws
  //    at runtime with an unhelpful D1 error. Chunking keeps each call within
  //    the limit while preserving the sequential ordering required for correctness
  //    (e.g. cell_validators UPSERT must precede the cells.validated recompute).
  for (let i = 0; i < stmts.length; i += D1_BATCH_LIMIT) {
    await db.batch(stmts.slice(i, i + D1_BATCH_LIMIT))
  }

  // 5. Count the resulting rows for the response.
  const [cellsResult, validatorsResult] = await Promise.all([
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM cells WHERE file_id IN (SELECT id FROM files WHERE project_id = ?)',
      )
      .bind(projectId)
      .first<{ cnt: number }>(),
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM cell_validators WHERE project_id = ?',
      )
      .bind(projectId)
      .first<{ cnt: number }>(),
  ])

  const completedAt = Date.now()

  return Response.json({
    ok: true,
    eventsRead,
    statementsApplied,
    cellsAfter: cellsResult?.cnt ?? 0,
    validatorsAfter: validatorsResult?.cnt ?? 0,
    startedAt,
    completedAt,
    note: 'Rebuild is not atomic; if the worker died mid-rebuild, projection rows may be incomplete. Re-run this endpoint to recover.',
  })
}
