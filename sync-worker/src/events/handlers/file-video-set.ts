// Pure handler for AuthorizedEvent<'file.video.set'>.
//
// Sets (or clears) the file's core video URL for the timeline editor preview.
// The URL lives in files.meta JSON alongside orderedBy/languages. Writes the
// canonical event row PLUS a files UPDATE (shared SQL with the rebuild
// projection — buildFileVideoSetStmt) so the link shows up for every
// collaborator on the next read. Non-chain-mutating; mirrors handleFileRename.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import { buildFileVideoSetStmt } from '../event-projection'
import type { DispatchResult } from './types'

export function handleFileVideoSet(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.video.set'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.video.set event ${event.id} is missing fileId`)
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
  })

  const fileUpdate = buildFileVideoSetStmt(
    db,
    event.projectId,
    event.fileId,
    event.id,
    event.payload.coreMediaUrl,
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
