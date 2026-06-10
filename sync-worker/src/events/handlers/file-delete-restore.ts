// Pure handlers for AuthorizedEvent<'file.delete'> and AuthorizedEvent<'file.restore'>.
//
// file.delete  — stamps `files.deleted_at` with epoch-ms. Non-chain-mutating.
//                Cells and audio rows are RETAINED; R2 wipe is deferred.
//                Tombstoned files are excluded from normal file listings by
//                the read route (`deleted_at IS NULL`).
//
// file.restore — clears `files.deleted_at` back to NULL. All cells and audio
//                remain intact and reappear in normal listings immediately.
//
// Both follow the file.rename pattern: write the event row + a single files UPDATE.
// A WHERE-miss (stale or missing file) changes zero rows — the event still lands
// in the log for history, consistent with file.rename's idempotency posture.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { DispatchResult } from './types'

export function handleFileDelete(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.delete'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.delete event ${event.id} is missing fileId`)
  }

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
      event.fileId,
      null,
      event.parentId ?? null,
      event.kind,
      claims.username,
      JSON.stringify(event.payload),
      event.clientTs,
      serverTs,
      event.projectId,
    )

  // Stamp the tombstone. Only advances when the file is currently active
  // (deleted_at IS NULL) — idempotent on double-delete.
  const fileUpdate = db
    .prepare(
      `UPDATE files
          SET deleted_at = ?, updated_at = (extract(epoch from now()) * 1000)::bigint
        WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
    )
    .bind(serverTs, event.fileId, event.projectId)

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

export function handleFileRestore(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.restore'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.restore event ${event.id} is missing fileId`)
  }

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
      event.fileId,
      null,
      event.parentId ?? null,
      event.kind,
      claims.username,
      JSON.stringify(event.payload),
      event.clientTs,
      serverTs,
      event.projectId,
    )

  // Clear the tombstone. Only advances when the file is currently tombstoned
  // (deleted_at IS NOT NULL) — idempotent on double-restore.
  const fileUpdate = db
    .prepare(
      `UPDATE files
          SET deleted_at = NULL, updated_at = (extract(epoch from now()) * 1000)::bigint
        WHERE id = ? AND project_id = ? AND deleted_at IS NOT NULL`,
    )
    .bind(event.fileId, event.projectId)

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
