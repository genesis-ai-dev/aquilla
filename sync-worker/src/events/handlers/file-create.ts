// Pure handler for AuthorizedEvent<'file.create'>.
//
// Writes the canonical event row PLUS a `files` UPSERT so the file shows
// up in the project listing immediately after import — before any user
// opens the file. UPSERT semantics: administrative fields (name, type,
// languages) always overwrite; counters (cell_count, approved_count,
// word_count, last_edit_at) are NOT touched here — they're maintained by
// the cell-event projection path.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { DispatchResult } from './types'

export interface HandleFileCreateOptions {
  serverSeq: number
}

export function handleFileCreate(
  db: D1Database,
  authed: AuthorizedEvent<'file.create'>,
  serverTs: number,
  opts: HandleFileCreateOptions,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.create event ${event.id} is missing fileId`)
  }

  const eventInsert = db
    .prepare(
      `INSERT OR IGNORE INTO events (
        id, schema_version, project_id, file_id, cell_id, parent_id, kind,
        author, payload, client_ts, server_ts, server_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      opts.serverSeq,
    )

  const fileUpsert = db
    .prepare(
      `INSERT INTO files (
        id, project_id, name, file_type, source_language, target_language,
        cell_count, approved_count, word_count, last_edit_at, projected_from,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, unixepoch('now') * 1000)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        file_type = excluded.file_type,
        source_language = excluded.source_language,
        target_language = excluded.target_language,
        updated_at = unixepoch('now') * 1000`,
    )
    .bind(
      event.fileId,
      event.projectId,
      event.payload.name,
      event.payload.fileType,
      event.payload.sourceLanguage ?? null,
      event.payload.targetLanguage ?? null,
      `event:${event.id}`,
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
    stmts: [eventInsert, fileUpsert],
    eventFrame,
    dirtyTables: ['events', 'files'] as ProjectionTable[],
  }
}
