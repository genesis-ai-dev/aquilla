// Handler for comment.* event kinds.
//
// Comments are non-chain-mutating: they don't move any cell's event_id chain
// head. Each comment.* event writes the canonical events row (for history /
// audit) and then updates the `comments` projection table.
//
// The comments projection is a simple UPSERT/UPDATE/soft-delete table —
// no AD-2 first-child-of-parent guard is needed. The projector logic lives in
// event-projection.ts (buildEventProjectionStmts); this handler is just the
// glue that builds the events INSERT + calls the projector.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { EventKind } from '../types'
import { buildEventProjectionStmts, type PersistedEvent } from '../event-projection'
import type { DispatchResult } from './types'

export type CommentEventKind = Extract<
  EventKind,
  'comment.create' | 'comment.edit' | 'comment.delete' | 'comment.resolve'
>

export function handleCommentEvent(
  db: D1Database,
  authed: AuthorizedEvent<CommentEventKind>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  // server_seq is derived atomically inside the INSERT — see import-route.ts.
  const eventInsert = db
    .prepare(
      `INSERT INTO events (
        id, schema_version, project_id, file_id, cell_id, parent_id, kind,
        author, payload, client_ts, server_ts, server_seq
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1
        ON CONFLICT DO NOTHING`,
    )
    .bind(
      event.id,
      event.schemaVersion,
      event.projectId,
      event.fileId ?? null,
      event.cellId ?? null,
      event.parentId ?? null,
      event.kind,
      claims.username,
      JSON.stringify(event.payload),
      event.clientTs,
      serverTs,
      event.projectId,
    )

  const persisted: PersistedEvent = {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId ?? null,
    cellId: event.cellId ?? null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payload: event.payload,
    clientTs: event.clientTs,
    serverTs,
    callerRole: claims.roleLevel,
  }

  const stmts: D1PreparedStatement[] = [eventInsert]
  const projectionTouches = buildEventProjectionStmts(db, persisted, stmts)

  const dirtyTables: ProjectionTable[] = ['events', ...projectionTouches]

  const eventFrame: Extract<RealtimeMessage, { t: 'event' }> = {
    v: 1,
    t: 'event',
    id: event.id,
    kind: event.kind,
    project: event.projectId,
    file: event.fileId,
    ts: serverTs,
  }

  return {
    stmts,
    eventFrame,
    dirtyTables,
  }
}
