// Pure handler for AuthorizedEvent<'file.corpus.set'>.
//
// Sets (or clears) the file's sidebar corpus group. The marker lives in
// files.meta JSON alongside orderedBy/languages — it is a FILE-level
// folder label, not cell data. Null clears the key so the file lands in
// Ungrouped. Writes the canonical event row PLUS a files UPDATE (shared
// SQL with the rebuild projection — buildFileCorpusSetStmt).
// Non-chain-mutating; contributor floor (same class as file.rename).

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import { buildFileCorpusSetStmt } from '../event-projection'
import { CORPUS_MARKER_MAX_LEN } from '../corpus-marker'
import type { DispatchResult } from './types'

export function handleFileCorpusSet(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.corpus.set'>,
  serverTs: number,
  serverSeq: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.corpus.set event ${event.id} is missing fileId`)
  }
  const marker = event.payload.corpusMarker
  if (marker !== null && (typeof marker !== 'string' || marker.trim().length > CORPUS_MARKER_MAX_LEN)) {
    throw new Error(`file.corpus.set event ${event.id} carries an unusable corpusMarker`)
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

  const fileUpdate = buildFileCorpusSetStmt(
    db,
    event.projectId,
    event.fileId,
    event.id,
    marker,
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
