// Handler for term.* event kinds (AQU-1006 follow-up).
//
// Terminology concepts are non-chain-mutating and PROJECT-scoped: they move no
// cell's event_id chain head and belong to no file. Each term.* event writes
// the canonical events row (history / audit — the trail that says who proposed
// a term and who approved it) and then updates the `concepts` projection.
//
// Structurally identical to comment-events.ts, and for the same reasons: a
// simple UPSERT/UPDATE/soft-delete projection with no AD-2 first-child-of-
// parent guard. The projector logic lives in event-projection.ts
// (buildEventProjectionStmts); this handler is just the glue.
//
// The authority split (suggest = contributor, approve = the org's termbase
// floor) is enforced upstream in authorize.ts via termbase-authority.ts, not
// here — this handler runs only on an already-authorized event.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { EventKind } from '../types'
import { buildEventProjectionStmts, type PersistedEvent } from '../event-projection'
import { buildEventInsertStmt } from '../event-insert'
import type { DispatchResult } from './types'

export type TermEventKind = Extract<
  EventKind,
  'term.create' | 'term.update' | 'term.delete' | 'term.approve' | 'term.reject'
>

export function handleTermEvent(
  db: AquillaDb,
  authed: AuthorizedEvent<TermEventKind>,
  serverTs: number,
  /** Pre-allocated server_seq for this event (AQU-1005). */
  serverSeq: number,
): DispatchResult {
  const { event, claims } = authed

  // `term.*` events always carry the project sentinel as fileId, so the
  // events row stores NULL — the same normalization comment.* does for its
  // project-scoped threads.
  const fileId = event.fileId === '__project__' ? null : (event.fileId ?? null)

  const eventInsert = buildEventInsertStmt(db, {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId,
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
    fileId,
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
