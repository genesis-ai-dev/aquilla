// AQU-1767 phase 2: removing a row can be undone.
//
// `source.cell.delete` destroys most of what hangs off a cell (AQU-1068's
// cascade): every lane's translation, the validators, waivers, back-
// translations and morph rows are DELETED; takes are soft-deleted, links
// tombstoned, comments blanked. Nothing in the event log can rebuild that
// state, so the delete's projection copies it into `removed_cell_archive`
// first — same batch, same chain gate — and `source.cell.restore` puts it back.
//
// WHAT COMES BACK, AND WHAT DOES NOT.
//   - Rows (source + every lane), validators, waivers, back-translations and
//     morph rows: re-inserted exactly as archived (ON CONFLICT DO NOTHING).
//   - Takes, links, comments: un-deleted ONLY where the removal itself took
//     them and nobody has touched them since (the row's event_id / the
//     removal's own deleted_at are unchanged). A take somebody removed on its
//     own before the removal stays removed; one re-attached since keeps that.
//   - The removal's chain claim is RELEASED. The restored source row keeps its
//     old head (so no translation goes stale — AD-9 compares against it), and
//     the removal had claimed the (cell, old head) slot; without the release
//     the next edit chained on that head would lose its slot to a delete that
//     no longer stands.
//
// SINGLE-USE AND REPLAY-SAFE. The first restore statement stamps `restored_by`
// (only while no live source row exists); every later statement keys off that
// stamp. A projection rebuild replays the restore after the delete has removed
// the rows again, finds its own stamp, and lands on the same state. The archive
// itself is written once (ON CONFLICT DO NOTHING): a rebuild replaying the
// delete against later state must not overwrite what the live removal saw.

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'

/**
 * Every `cells` column a restore writes back, in table order. `value_tsv` is
 * GENERATED, so it is left out (Postgres refuses a value for it). A guard test
 * (removed-cell-archive.test.ts) compares this list with schema.sql, so a new
 * column cannot be silently dropped from restored rows.
 */
export const CELLS_RESTORE_COLUMNS = [
  'project_id',
  'file_id',
  'cell_id',
  'side',
  'value',
  'value_html',
  'type',
  'canonical_ref',
  'anchor_cell_id',
  'event_id',
  'source_event_id',
  'last_editor',
  'last_edit_at',
  'validated',
  'word_count',
  'content_hash',
  'endorsement_count',
  'ai_drafted',
  'ai_draft',
  'start_ms',
  'end_ms',
  'medium',
  'sequence_index',
  'transcription',
  'camera_state',
  'metadata',
  'source_location',
  'upstream_event_id',
  'upstream_seq',
  'tombstoned_at',
  'upstream_cell_id',
  'lane_id',
  'hidden_at',
] as const

/** Tables restored row-for-row from the archive (no generated columns). */
const ROW_TABLES = [
  ['validators', 'cell_validators'],
  ['waivers', 'cell_waivers'],
  ['backtranslations', 'cell_backtranslations'],
  ['glosses', 'cell_glosses'],
  ['morph', 'cell_word_morph'],
] as const

/**
 * The archive statement for a `source.cell.delete`. Must run BEFORE the
 * cascade (it reads what the cascade is about to take), and carries the same
 * gate fragment as the cascade so a delete that lost its chain slot archives
 * nothing. Archives only when a source row exists — a delete with nothing to
 * remove has nothing to put back.
 */
export function buildRemovedCellArchiveStmt(
  db: AquillaDb,
  event: { id: string; projectId: string; fileId: string; cellId: string; author: string; serverTs: number },
  gateAnd: string,
  gateBinds: readonly unknown[],
): AquillaStatement {
  const cell = [event.projectId, event.fileId, event.cellId]
  const rowsOf = (table: string) =>
    `COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM ${table} t
                WHERE t.project_id = ? AND t.file_id = ? AND t.cell_id = ?), '[]'::jsonb)`
  return db
    .prepare(
      `INSERT INTO removed_cell_archive
         (delete_event_id, project_id, file_id, cell_id, deleted_by, deleted_ts,
          cells_rows, validators, waivers, backtranslations, glosses, morph, audio, links, comments)
       SELECT ?, ?, ?, ?, ?, ?,
         COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'value_tsv') FROM cells c
                    WHERE c.project_id = ? AND c.file_id = ? AND c.cell_id = ?), '[]'::jsonb),
         ${rowsOf('cell_validators')},
         ${rowsOf('cell_waivers')},
         ${rowsOf('cell_backtranslations')},
         ${rowsOf('cell_glosses')},
         ${rowsOf('cell_word_morph')},
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'audio_id', a.audio_id, 'selected', a.selected, 'event_id', a.event_id))
                    FROM cell_audio a
                   WHERE a.project_id = ? AND a.file_id = ? AND a.cell_id = ? AND a.deleted = 0), '[]'::jsonb),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'kind', l.kind, 'from_file_id', l.from_file_id, 'from_cell_id', l.from_cell_id,
                     'to_file_id', l.to_file_id, 'to_cell_id', l.to_cell_id, 'event_id', l.event_id))
                    FROM cell_links l
                   WHERE l.project_id = ? AND l.linked = 1
                     AND ((l.from_file_id = ? AND l.from_cell_id = ?) OR (l.to_file_id = ? AND l.to_cell_id = ?))),
                  '[]'::jsonb),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'comment_id', m.comment_id, 'body', m.body, 'updated_at', m.updated_at))
                    FROM comments m
                   WHERE m.project_id = ? AND m.file_id = ? AND m.cell_id = ?
                     AND m.scope_kind = 'cell' AND m.deleted_at IS NULL), '[]'::jsonb)
       WHERE EXISTS (SELECT 1 FROM cells s
                      WHERE s.project_id = ? AND s.file_id = ? AND s.cell_id = ? AND s.side = 'source')${gateAnd}
       ON CONFLICT (delete_event_id) DO NOTHING`,
    )
    .bind(
      event.id,
      ...cell,
      event.author,
      event.serverTs,
      ...cell, // cells
      ...cell, // validators
      ...cell, // waivers
      ...cell, // backtranslations
      ...cell, // glosses
      ...cell, // morph
      ...cell, // audio
      event.projectId,
      event.fileId,
      event.cellId,
      event.fileId,
      event.cellId, // links
      ...cell, // comments
      ...cell, // the source-row check
      ...gateBinds,
    )
}

/**
 * The statements of a `source.cell.restore`, in batch order. The first stamps
 * the chosen archive (`restored_by`) — and only while no live source row
 * exists; every later statement does nothing unless that stamp is this event's.
 */
export function buildRemovedCellRestoreStmts(
  db: AquillaDb,
  event: { id: string; projectId: string; fileId: string; cellId: string; serverTs: number },
  deleteEventId: string | null,
): AquillaStatement[] {
  const cell = [event.projectId, event.fileId, event.cellId]
  const mine = `a.restored_by = ? AND a.project_id = ? AND a.file_id = ? AND a.cell_id = ?`
  const mineBinds = [event.id, ...cell]
  const stmts: AquillaStatement[] = []

  // 1. Claim the archive. Prefer one this event already holds (a rebuild
  //    replay), else the newest unrestored removal — or the one named.
  stmts.push(
    db
      .prepare(
        `UPDATE removed_cell_archive SET restored_by = ?, restored_ts = ?
          WHERE delete_event_id = (
                SELECT delete_event_id FROM removed_cell_archive
                 WHERE project_id = ? AND file_id = ? AND cell_id = ?
                   AND delete_event_id = COALESCE(?::text, delete_event_id)
                   AND (restored_by IS NULL OR restored_by = ?)
                 ORDER BY (restored_by IS NOT NULL) DESC, deleted_ts DESC, delete_event_id DESC
                 LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM cells s
                             WHERE s.project_id = ? AND s.file_id = ? AND s.cell_id = ? AND s.side = 'source')`,
      )
      .bind(event.id, event.serverTs, ...cell, deleteEventId, event.id, ...cell),
  )

  // 2. The rows: source + every lane, exactly as archived.
  const cols = CELLS_RESTORE_COLUMNS.join(', ')
  const rCols = CELLS_RESTORE_COLUMNS.map((c) => `r.${c}`).join(', ')
  stmts.push(
    db
      .prepare(
        `INSERT INTO cells (${cols})
         SELECT ${rCols}
           FROM removed_cell_archive a
           CROSS JOIN LATERAL jsonb_populate_recordset(NULL::cells, a.cells_rows) AS r
          WHERE ${mine}
         ON CONFLICT DO NOTHING`,
      )
      .bind(...mineBinds),
  )

  // 3. Validators, waivers, back-translations, morph rows.
  for (const [column, table] of ROW_TABLES) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO ${table}
           SELECT r.*
             FROM removed_cell_archive a
             CROSS JOIN LATERAL jsonb_populate_recordset(NULL::${table}, a.${column}) AS r
            WHERE ${mine}
           ON CONFLICT DO NOTHING`,
        )
        .bind(...mineBinds),
    )
  }

  // 4. Takes the removal soft-deleted, untouched since (event_id unchanged).
  stmts.push(
    db
      .prepare(
        `UPDATE cell_audio ca SET deleted = 0, selected = x.selected
           FROM removed_cell_archive a
           CROSS JOIN LATERAL jsonb_to_recordset(a.audio) AS x(audio_id TEXT, selected INTEGER, event_id TEXT)
          WHERE ${mine}
            AND ca.project_id = a.project_id AND ca.file_id = a.file_id AND ca.cell_id = a.cell_id
            AND ca.audio_id = x.audio_id AND ca.deleted = 1 AND ca.event_id = x.event_id`,
      )
      .bind(...mineBinds),
  )

  // 5. Links the removal tombstoned, untouched since.
  stmts.push(
    db
      .prepare(
        `UPDATE cell_links cl SET linked = 1
           FROM removed_cell_archive a
           CROSS JOIN LATERAL jsonb_to_recordset(a.links)
                AS x(kind TEXT, from_file_id TEXT, from_cell_id TEXT, to_file_id TEXT, to_cell_id TEXT, event_id TEXT)
          WHERE ${mine}
            AND cl.project_id = a.project_id AND cl.kind = x.kind
            AND cl.from_file_id = x.from_file_id AND cl.from_cell_id = x.from_cell_id
            AND cl.to_file_id = x.to_file_id AND cl.to_cell_id = x.to_cell_id
            AND cl.linked = 0 AND cl.event_id = x.event_id`,
      )
      .bind(...mineBinds),
  )

  // 6. Comments the removal blanked — still blank, still stamped by it.
  stmts.push(
    db
      .prepare(
        `UPDATE comments m SET body = x.body, deleted_at = NULL, updated_at = x.updated_at
           FROM removed_cell_archive a
           CROSS JOIN LATERAL jsonb_to_recordset(a.comments) AS x(comment_id TEXT, body TEXT, updated_at BIGINT)
          WHERE ${mine}
            AND m.project_id = a.project_id AND m.comment_id = x.comment_id
            AND m.deleted_at = a.deleted_ts AND m.body = ''`,
      )
      .bind(...mineBinds),
  )

  // 7. Release the removal's chain claim (see the header).
  stmts.push(
    db
      .prepare(
        `DELETE FROM chain_claims c
          USING removed_cell_archive a
          WHERE ${mine}
            AND c.project_id = a.project_id AND c.file_id = a.file_id AND c.cell_id = a.cell_id
            AND c.event_id = a.delete_event_id`,
      )
      .bind(...mineBinds),
  )
  return stmts
}

/** What the perimeter needs to decide whether a restore may go ahead. */
export interface RestorableRemoval {
  deleteEventId: string
  deletedBy: string
}

/**
 * The removal a restore would undo — the one named, or the cell's newest
 * unrestored one — or null when there is nothing to put back (no archive, or
 * the cell is live again).
 */
export async function findRestorableRemoval(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
  deleteEventId: string | null,
): Promise<RestorableRemoval | null> {
  const live = await db
    .prepare(`SELECT 1 AS one FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source' LIMIT 1`)
    .bind(projectId, fileId, cellId)
    .first<{ one: number }>()
  if (live) return null
  const row = await db
    .prepare(
      `SELECT delete_event_id, deleted_by FROM removed_cell_archive
        WHERE project_id = ? AND file_id = ? AND cell_id = ?
          AND delete_event_id = COALESCE(?::text, delete_event_id)
          AND restored_by IS NULL
        ORDER BY deleted_ts DESC, delete_event_id DESC
        LIMIT 1`,
    )
    .bind(projectId, fileId, cellId, deleteEventId)
    .first<{ delete_event_id: string; deleted_by: string }>()
  return row ? { deleteEventId: row.delete_event_id, deletedBy: row.deleted_by } : null
}
