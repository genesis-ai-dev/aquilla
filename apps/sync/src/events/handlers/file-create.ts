// Pure handler for AuthorizedEvent<'file.create'>.
//
// Writes the canonical event row PLUS a `files` UPSERT so the file shows
// up in the project listing immediately after import — before any user
// opens the file. UPSERT semantics: administrative fields (name, role,
// kind, semantics, meta) and the `event_id` chain head always overwrite;
// counters (cell_count, approved_count, word_count, last_edit_at) and the
// created_* audit fields are NOT touched on conflict — counters are
// maintained by the cell-event projection path.
//
// Spec alignment (03-data-model.md §"File", 2026-05-21 revision): the row
// carries `role`, `kind`, `book_code`, `source_file_id`, `anchor_file_id`
// as columns and an `event_id` chain head; sparse provenance + per-file
// language overrides (`r2_key`, `blob_sha`, `import_format`,
// `parser_version`, `source_language`, `target_language`) are consolidated
// into the JSON `meta` column per §"Column vs JSON meta". The legacy
// `file_type` column is gone — files-read derives a compatible `fileType`
// from `kind ?? role ?? 'codex'`.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { DispatchResult } from './types'
import { buildFileMeta } from '../file-meta'

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

  // Sparse provenance + per-file language overrides go into `meta` (JSON);
  // role/kind/book_code/pairing stay as columns. `event_id` is this
  // file.create's id (the AD-2 chain head). created_* are set on insert
  // only; counters are maintained by the cell-event projection path.
  const meta = buildFileMeta(event.payload)

  const fileUpsert = db
    .prepare(
      `INSERT INTO files (
        id, project_id, name,
        role, kind, book_code, source_file_id, anchor_file_id,
        event_id,
        cell_count, approved_count, word_count, last_edit_at,
        created_by, created_at, updated_at,
        meta
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?,
        0, 0, 0, NULL,
        ?, unixepoch('now') * 1000, unixepoch('now') * 1000,
        ?
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        kind = excluded.kind,
        book_code = excluded.book_code,
        source_file_id = excluded.source_file_id,
        anchor_file_id = excluded.anchor_file_id,
        event_id = excluded.event_id,
        meta = excluded.meta,
        updated_at = unixepoch('now') * 1000`,
    )
    .bind(
      event.fileId,
      event.projectId,
      event.payload.name,
      event.payload.role ?? null,
      event.payload.kind ?? null,
      event.payload.bookCode ?? null,
      event.payload.sourceFileId ?? null,
      event.payload.anchorFileId ?? null,
      event.id,
      claims.username,
      meta,
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
