// POST /migrate/ingest — trusted bulk event ingest for legacy-Codex migration.
//
// The generic POST /events route binds `author` to the caller's JWT and mints
// its own server-side ids; POST /import does the same and only emits source
// genesis events. Neither can reproduce a *legacy* edit with its ORIGINAL
// author, its ORIGINAL timestamp, and a DETERMINISTIC id. This route can,
// because it is gated on the service credential (SYNC_SECRET_KEY) — the same
// trust tier as /admin/.../rebuild-projection.
//
// The operator CLI (scripts/migrate.ts) parses a legacy project, maps it to a
// stream of fully-formed event envelopes (deterministic UUIDv5 ids, original
// author, legacy clientTs, correct parent chain) and POSTs them here in chunks.
// We reuse buildEventProjectionStmts verbatim, so migrated rows are byte-
// identical to dispatcher / import rows.
//
// Idempotency: events.id is the deterministic key; `INSERT OR IGNORE` drops
// replays and the projection is UPSERT-based (+ self-healing counters), so a
// re-run inserts 0 new events and converges the projection to the same state.
// Event-insert + projection ride in the same d1.batch, so an interrupted run
// leaves a clean prefix and the re-run completes the rest.
//
// SECURITY: this route trusts the body's author/id/timestamp. It must NEVER be
// reachable by browser clients — only holders of SYNC_SECRET_KEY may call it.

import { buildEventProjectionStmts, type PersistedEvent } from './event-projection'
import type { EventKind } from './types'

const D1_BATCH_LIMIT = 100

export interface MigrateIngestEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

/** One fully-formed event envelope from the migration engine. Unlike RawEvent,
 *  `author` + `clientTs` + `id` are authoritative — that is the trust this
 *  route grants in exchange for the service credential. */
interface IngestEvent {
  id: string
  kind: EventKind
  fileId?: string | null
  cellId?: string | null
  parentId?: string | null
  author: string
  clientTs: number
  payload: unknown
}

interface MigrateIngestBody {
  projectId: string
  events: IngestEvent[]
}

function isMigrateIngestBody(x: unknown): x is MigrateIngestBody {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return typeof b.projectId === 'string' && Array.isArray(b.events)
}

// Same atomic server_seq-assigning INSERT as import-route.ts: the correlated
// subquery picks the next free per-project seq inside the statement, so
// sequential batches never collide and INSERT OR IGNORE leaves no seq gap on
// replays (the row is dropped before the seq is consumed).
const EVENT_INSERT_SQL = `INSERT OR IGNORE INTO events (
  id, schema_version, project_id, file_id, cell_id, parent_id, kind,
  author, payload, client_ts, server_ts, server_seq
)
SELECT ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1`

const INGEST_PATH = '/migrate/ingest'

/**
 * POST /migrate/ingest
 *
 * Body: { projectId, events: IngestEvent[] }
 * Returns: { accepted: number } | error
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleMigrateIngestRequest(
  request: Request,
  env: MigrateIngestEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== INGEST_PATH) return null
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }
  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  const authHeader = request.headers.get('Authorization') ?? ''
  if (authHeader !== `Bearer ${env.SYNC_SECRET_KEY}`) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_DB) {
    return new Response('AQUILLA_DB binding not configured', { status: 500 })
  }
  const db = env.AQUILLA_DB

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  if (!isMigrateIngestBody(body)) {
    return new Response('body must be { projectId, events[] }', { status: 400 })
  }

  // serverTs is monotonic within the request; server_seq is assigned in SQL.
  // clientTs carries the original legacy edit timestamp (preserves history
  // ordering); it is NOT part of any deterministic id.
  let serverTs = Date.now()
  const stmts: D1PreparedStatement[] = []

  for (const e of body.events) {
    if (typeof e.id !== 'string' || typeof e.kind !== 'string' || typeof e.author !== 'string') {
      return new Response('each event needs string id, kind, author', { status: 400 })
    }
    const event: PersistedEvent = {
      id: e.id,
      schemaVersion: 1,
      projectId: body.projectId,
      fileId: e.fileId ?? null,
      cellId: e.cellId ?? null,
      parentId: e.parentId ?? null,
      kind: e.kind,
      author: e.author,
      payload: e.payload,
      clientTs: typeof e.clientTs === 'number' ? e.clientTs : Date.now(),
      serverTs: serverTs++,
    }

    stmts.push(
      db
        .prepare(EVENT_INSERT_SQL)
        .bind(
          event.id,
          event.projectId,
          event.fileId,
          event.cellId,
          event.parentId,
          event.kind,
          event.author,
          JSON.stringify(event.payload),
          event.clientTs,
          event.serverTs,
          event.projectId,
        ),
    )
    try {
      buildEventProjectionStmts(db, event, stmts)
    } catch (err) {
      // Unknown kind or malformed payload — surface the offending event so the
      // CLI can pinpoint it rather than failing the whole batch opaquely.
      return new Response(
        `cannot project event ${event.id} (kind: ${event.kind}): ${String(err)}`,
        { status: 400 },
      )
    }
  }

  try {
    for (let i = 0; i < stmts.length; i += D1_BATCH_LIMIT) {
      await db.batch(stmts.slice(i, i + D1_BATCH_LIMIT))
    }
  } catch (err) {
    return Response.json({ error: `D1 batch failed: ${String(err)}` }, { status: 500 })
  }

  return Response.json({ accepted: body.events.length })
}
