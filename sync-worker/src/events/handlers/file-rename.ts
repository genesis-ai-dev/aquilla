// Pure handler for AuthorizedEvent<'file.rename'>.
//
// Renames a file's display label. Writes the canonical event row PLUS a
// `files` UPDATE so the new name shows up in the project listing on the next
// read — for every collaborator, not just the device that applied it.
//
// Mirrors handleFileCreate, but UPDATEs an existing row instead of UPSERTing:
// only `name`, the AD-2 chain head (`event_id`, advanced to this event), and
// `updated_at` change. Structural columns (kind, role, source_file_id, …),
// the language `meta`, and the counters are deliberately left untouched.
// (Corpus/grouping markers are not yet server-backed — see auth-worker's
// `loadFilesByProject` read; renaming the grouping is a separate follow-up.)

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { DispatchResult } from './types'

export function handleFileRename(
  db: D1Database,
  authed: AuthorizedEvent<'file.rename'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.rename event ${event.id} is missing fileId`)
  }

  // server_seq is derived atomically inside the INSERT — see file-create.ts.
  const eventInsert = db
    .prepare(
      `INSERT OR IGNORE INTO events (
        id, schema_version, project_id, file_id, cell_id, parent_id, kind,
        author, payload, client_ts, server_ts, server_seq
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1`,
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

  // Advance the file row: new label + chain head. A WHERE-miss (file never
  // imported) changes zero rows — the event still lands for history, matching
  // file.create's INSERT-OR-IGNORE idempotency posture.
  const fileUpdate = db
    .prepare(
      `UPDATE files
          SET name = ?, event_id = ?, updated_at = unixepoch('now') * 1000
        WHERE id = ? AND project_id = ?`,
    )
    .bind(event.payload.name, event.id, event.fileId, event.projectId)

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
