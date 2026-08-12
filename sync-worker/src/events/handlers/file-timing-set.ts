// Pure handler for AuthorizedEvent<'file.timing.set'>.
//
// Sets (or clears) the file's audio timing mode (Original vs Free). The mode
// lives in files.meta JSON alongside orderedBy/languages/coreMediaUrl — it is
// a FILE-level distinction (the video link it interacts with is per-file
// too). Null clears the key, dropping the file back to the project-level
// default. Writes the canonical event row PLUS a files UPDATE (shared SQL
// with the rebuild projection — buildFileTimingSetStmt). Non-chain-mutating;
// mirrors handleFileVideoSet. Maintainer floor (role-policy) — structural,
// the same clearance the setting had in Project Settings.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import { buildFileTimingSetStmt } from '../event-projection'
import type { DispatchResult } from './types'

export function handleFileTimingSet(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.timing.set'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.timing.set event ${event.id} is missing fileId`)
  }
  const mode = event.payload.timingMode
  if (mode !== 'dubbing' && mode !== 'audioFirst' && mode !== null) {
    throw new Error(`file.timing.set event ${event.id} carries an unknown mode: ${String(mode)}`)
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

  const fileUpdate = buildFileTimingSetStmt(
    db,
    event.projectId,
    event.fileId,
    event.id,
    mode,
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
