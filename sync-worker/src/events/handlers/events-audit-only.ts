// Events that only append to the audit log (no projection row yet).

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { DispatchResult } from './cell-commit'

export function handleEventsAuditOnly(
  db: D1Database,
  authed: AuthorizedEvent,
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

  const dirtyTables: ProjectionTable[] = ['events']

  return { stmts: [eventInsert], eventFrame, dirtyTables }
}
