// Pure handler for AuthorizedEvent<'cell.commit'>.
//
// Responsibility: given a fully-authorized cell.commit event, compute:
//   1. The events table INSERT statement (canonical audit row).
//   2. The cells UPSERT statement (projection), via buildEventProjectionStmts.
//   3. The Realtime event frame to broadcast to room participants.
//   4. The set of ProjectionTable values that became dirty.
//
// The caller (dispatch.ts → route.ts) batches the statements, accumulates
// the eventFrames for broadcast (Task B), and tracks dirty tables for
// projection.dirty fanout.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventProjectionStmts, type PersistedEvent } from '../event-projection'

export interface DispatchResult {
  /**
   * The events INSERT statement, plus any projection statements.
   * Caller accumulates these across all events in the batch and then
   * issues them in D1_BATCH_LIMIT-sized chunks via db.batch().
   */
  stmts: D1PreparedStatement[]
  /**
   * Per-event Realtime frame. Caller may coalesce many of these for
   * broadcast (Task B). For Phase 1, the frames are accumulated but
   * not yet sent — see the TODO in route.ts.
   */
  eventFrame: Extract<RealtimeMessage, { t: 'event' }>
  /**
   * Tables changed by this event. Caller unions across events for the
   * projection.dirty broadcast payload.
   */
  dirtyTables: ProjectionTable[]
}

/**
 * Handle one AuthorizedEvent<'cell.commit'>.
 *
 * Returns the statements to batch into D1 plus metadata for the Realtime
 * fanout (Task B). Does NOT write to D1 or broadcast — those are the
 * caller's responsibility, so this function remains pure and testable.
 *
 * The events INSERT uses INSERT OR IGNORE for idempotency: if the client
 * retries a request with the same UUIDv7 event id, the second insert is a
 * no-op and the first write stands. The cells UPSERT is also LWW-guarded
 * (see event-projection.ts).
 */
export function handleCellCommit(
  db: D1Database,
  authed: AuthorizedEvent<'cell.commit'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  // 1. Canonical audit row INSERT.
  //    INSERT OR IGNORE: UUIDv7 collision = client retried. First write wins.
  //    Use claims.username (validated from JWT pipeline) rather than
  //    event.author (client-supplied), so that when Phase 1's TODO resolves
  //    the binding to a real JWT username claim this handler is already correct.
  const eventInsert = db
    .prepare(
      `INSERT OR IGNORE INTO events (
        id, schema_version, project_id, file_id, cell_id, kind, author,
        payload, client_ts, server_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      event.schemaVersion,
      event.projectId,
      event.fileId ?? null,
      event.cellId ?? null,
      event.kind,
      claims.username,
      JSON.stringify(event.payload),
      event.clientTs,
      serverTs,
    )

  // 2. Projection statements (cells UPSERT).
  const projectionStmts: D1PreparedStatement[] = []
  const persisted: PersistedEvent<'cell.commit'> = {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId ?? null,
    cellId: event.cellId ?? null,
    kind: event.kind,
    author: claims.username,
    payload: event.payload,
    clientTs: event.clientTs,
    serverTs,
  }
  buildEventProjectionStmts(db, persisted, projectionStmts)

  // 3. Realtime event frame.
  //    Sent to all room participants so they can invalidate local caches.
  const eventFrame: Extract<RealtimeMessage, { t: 'event' }> = {
    v: 1,
    t: 'event',
    id: event.id,
    kind: event.kind,
    project: event.projectId,
    file: event.fileId,
    cell: event.cellId,
    ts: serverTs,
  }

  // 4. Return combined statement list (events INSERT first, then projection).
  return {
    stmts: [eventInsert, ...projectionStmts],
    eventFrame,
    dirtyTables: ['events', 'cells'],
  }
}
