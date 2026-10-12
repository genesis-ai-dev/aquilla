// Pure handler for AuthorizedEvent<'file.reorder'>.
//
// AQU-1569: sets (or clears) the file's hand-placed position within its
// sidebar corpus group. The index lives in files.meta JSON alongside
// corpusMarker/orderedBy — it is a FILE-level presentation value, not cell
// data. Null clears the key so the file falls back under the automatic
// name-derived order. Writes the canonical event row PLUS a files UPDATE
// (shared SQL with the rebuild projection — buildFileSortIndexSetStmt), so a
// reorder reaches every collaborator on their next file-list read.
//
// Non-chain-mutating; project-lead floor — a reorder relayouts the sidebar for
// every member, which is the file.video.set rationale, not file.rename's.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import { buildFileSortIndexSetStmt } from '../event-projection'
import { usableSortIndex } from '../sort-index'
import type { DispatchResult } from './types'

export function handleFileReorder(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.reorder'>,
  serverTs: number,
  /** Pre-allocated server_seq for this event (AQU-1005: allocation happens
   *  once per request via allocateSeqRange, outside the write transaction). */
  serverSeq: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.reorder event ${event.id} is missing fileId`)
  }
  // Refused here rather than quietly cleared, because this is the only path a
  // NEW write takes: a client that computed a NaN has a bug worth surfacing,
  // and silently persisting "no position" would look like the drag worked.
  // The rebuild projection stays permissive for exactly the opposite reason.
  const sortIndex = event.payload.sortIndex
  if (sortIndex !== null && usableSortIndex(sortIndex) === undefined) {
    throw new Error(`file.reorder event ${event.id} carries an unusable sortIndex`)
  }

  const eventInsert = buildEventInsertStmt(db, {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId,
    cellId: null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs,
    serverSeq,
  })

  const fileUpdate = buildFileSortIndexSetStmt(
    db,
    event.projectId,
    event.fileId,
    event.id,
    sortIndex,
  )

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
    stmts: [eventInsert, fileUpdate],
    eventFrame,
    dirtyTables: ['events', 'files'] as ProjectionTable[],
  }
}
