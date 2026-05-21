// Pure handler for AuthorizedEvent<'file.create'>.
//
// Writes the canonical event row PLUS a `files` UPSERT so the file shows
// up in the project listing immediately after import — before any user
// opens the file. UPSERT semantics: administrative fields (name, type,
// languages, role/kind/import metadata) always overwrite; counters
// (cell_count, approved_count, word_count, last_edit_at) are NOT touched
// here — they're maintained by the cell-event projection path.
//
// Spec alignment (03-data-model.md §"File"): the row carries `role`,
// `kind`, `book_code`, `source_file_id`, `anchor_file_id`, `r2_key`,
// `import_format`, `parser_version` from the event payload. The legacy
// `file_type` column is kept in lockstep (`payload.fileType ?? payload.kind
// ?? payload.role ?? 'codex'`) so existing reads in `files-read-route.ts`
// keep returning a non-null value.

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

  // Legacy column fallback: keep `file_type` populated so pre-spec reads
  // keep working. New rows should set `role` + `kind` directly.
  const legacyFileType =
    event.payload.fileType ?? event.payload.kind ?? event.payload.role ?? 'codex'

  const fileUpsert = db
    .prepare(
      `INSERT INTO files (
        id, project_id, name, file_type, source_language, target_language,
        cell_count, approved_count, word_count, last_edit_at, projected_from,
        updated_at,
        role, kind, book_code, source_file_id, anchor_file_id,
        r2_key, import_format, parser_version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, unixepoch('now') * 1000,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        file_type = excluded.file_type,
        source_language = excluded.source_language,
        target_language = excluded.target_language,
        role = excluded.role,
        kind = excluded.kind,
        book_code = excluded.book_code,
        source_file_id = excluded.source_file_id,
        anchor_file_id = excluded.anchor_file_id,
        r2_key = excluded.r2_key,
        import_format = excluded.import_format,
        parser_version = excluded.parser_version,
        updated_at = unixepoch('now') * 1000`,
    )
    .bind(
      event.fileId,
      event.projectId,
      event.payload.name,
      legacyFileType,
      event.payload.sourceLanguage ?? null,
      event.payload.targetLanguage ?? null,
      `event:${event.id}`,
      event.payload.role ?? null,
      event.payload.kind ?? null,
      event.payload.bookCode ?? null,
      event.payload.sourceFileId ?? null,
      event.payload.anchorFileId ?? null,
      event.payload.r2Key ?? null,
      event.payload.importFormat ?? null,
      event.payload.parserVersion ?? null,
    )

  const eventFrame: Extract<RealtimeMessage, { t: 'event' }> = {
    v: 1,
    t: 'event',
    id: event.id,
    kind: event.kind,
    project: event.projectId,
    file: event.fileId,
    ts: serverTs,
    by: claims.username,
  }

  return {
    stmts: [eventInsert, fileUpsert],
    eventFrame,
    dirtyTables: ['events', 'files'] as ProjectionTable[],
  }
}
