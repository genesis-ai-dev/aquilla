// Pure handler for AuthorizedEvent<'file.extension.set'> (Smart Extensions
// apiRev 7).
//
// Replaces (or, with null, clears) files.meta.extension: the kind, tags, group,
// owner tool and small meta an extension records about a file. Writes the event
// row plus a files UPDATE (shared SQL with the rebuild projection —
// buildFileExtensionSetStmt). Non-chain-mutating; project-lead floor. An
// unparseable payload is refused before anything is logged.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import { buildFileExtensionSetStmt } from '../event-projection'
import { parseFileExtension } from '../../../../shared/tools/file-extension'
import type { DispatchResult } from './types'

export function handleFileExtensionSet(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.extension.set'>,
  serverTs: number,
  serverSeq: number,
): DispatchResult {
  const { event, claims } = authed
  if (!event.fileId) {
    throw new Error(`file.extension.set event ${event.id} is missing fileId`)
  }
  const extension = event.payload.extension
  if (extension !== null && extension !== undefined) {
    const parsed = parseFileExtension(extension)
    if (!parsed.ok) throw new Error(`file.extension.set event ${event.id}: ${parsed.error}`)
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
    stmts: [eventInsert, buildFileExtensionSetStmt(db, event.projectId, event.fileId, event.id, extension ?? null)],
    eventFrame,
    dirtyTables: ['events', 'files'] as ProjectionTable[],
  }
}
