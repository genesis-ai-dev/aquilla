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

export function handleFileCreate(
  db: D1Database,
  authed: AuthorizedEvent<'file.create'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.create event ${event.id} is missing fileId`)
  }

  // server_seq is derived atomically inside the INSERT — see import-route.ts.
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

  // Post-0012 `files` schema: `file_type` was collapsed into `role`/`kind`
  // and languages moved into the `meta` JSON (they're not file columns). The
  // legacy fileType maps onto `kind`; the read side resolves fileType as
  // `kind ?? role ?? 'codex'`. `event_id` (this file.create's id) is the
  // NOT NULL AD-2 chain head.
  const langMeta: Record<string, string> = {}
  if (event.payload.sourceLanguage) langMeta.sourceLanguage = event.payload.sourceLanguage
  if (event.payload.targetLanguage) langMeta.targetLanguage = event.payload.targetLanguage

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
        NULL, ?, NULL, NULL, NULL,
        ?,
        0, 0, 0, NULL,
        ?, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint,
        ?
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        event_id = excluded.event_id,
        meta = excluded.meta,
        updated_at = (extract(epoch from now()) * 1000)::bigint`,
    )
    .bind(
      event.fileId,
      event.projectId,
      event.payload.name,
      event.payload.fileType ?? null,
      event.id,
      claims.username,
      JSON.stringify(langMeta),
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
