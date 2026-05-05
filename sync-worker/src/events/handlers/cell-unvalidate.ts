import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventProjectionStmts, type PersistedEvent } from '../event-projection'
import type { DispatchResult } from './cell-commit'

export function handleCellUnvalidate(
  db: D1Database,
  authed: AuthorizedEvent<'cell.unvalidate'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

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

  const projectionStmts: D1PreparedStatement[] = []
  const persisted: PersistedEvent<'cell.unvalidate'> = {
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

  const dirtyTables: ProjectionTable[] = ['events', 'cell_validators', 'cells']

  return {
    stmts: [eventInsert, ...projectionStmts],
    eventFrame,
    dirtyTables,
  }
}
