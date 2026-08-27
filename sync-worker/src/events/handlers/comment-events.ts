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
import { buildEventInsertStmt } from '../event-insert'
import type { DispatchResult } from './types'

export type CommentEventKind = Extract<
  EventKind,
  'comment.create' | 'comment.edit' | 'comment.delete' | 'comment.resolve'
>

export function handleCommentEvent(
  db: AquillaDb,
  authed: AuthorizedEvent<CommentEventKind>,
  serverTs: number,
  /** Pre-allocated server_seq for this event (AQU-1005: allocation happens
   *  once per request via allocateSeqRange, outside the write transaction). */
  serverSeq: number,
): DispatchResult {
  const { event, claims } = authed

  const eventInsert = buildEventInsertStmt(db, {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId === "__project__" ? null : (event.fileId ?? null),
    cellId: event.cellId ?? null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs,
    serverSeq,
  })

  const persisted: PersistedEvent = {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId === "__project__" ? null : (event.fileId ?? null),
    cellId: event.cellId ?? null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payload: event.payload,
    clientTs: event.clientTs,
    serverTs,
    callerRole: claims.roleLevel,
  }

  const stmts: AquillaStatement[] = [eventInsert]
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
