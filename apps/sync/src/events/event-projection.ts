// Builds D1 statements that advance the `cells` / `cell_validators`
// projections in response to one persisted event.
//
// AD-2 first-child-of-parent rule:
//   Before applying any cell-mutating event, the caller (route.ts /
//   rebuild.ts) checks that no other event already exists with the same
//   `(project_id, file_id, cell_id, parent_id)` and an earlier server_seq.
//   If a sibling has already won, the new event is a stale branch — its
//   row stays in `events` (so history can surface it) but does NOT update
//   the projection. The route/rebuild loop's `applyEventProjection`
//   wrapper is the single place that runs the guard.
//
// AD-9 source pin:
//   `target.cell.commit` carries an optional `sourceEventId`. When set,
//   the projection writes it to `cells.source_event_id` so the stale-
//   source query is a direct pointer comparison.
//
// Hash function: djb2 (32-bit), unchanged. Kept as a cheap FTS-skipping
// fingerprint on `content_hash`.

import type { EventKind, EventPayloads } from './types'

// A single event row as it lives in D1. JSON.parse on `payload` is the
// caller's responsibility — `payload` here is already an object.
export interface PersistedEvent<K extends EventKind = EventKind> {
  id: string
  schemaVersion: number
  projectId: string
  fileId: string | null
  cellId: string | null
  /** AD-2: prior winning event on the cell's chain. */
  parentId: string | null
  kind: K
  author: string
  payload: unknown      // narrowed via kind in the switch below
  clientTs: number
  serverTs: number
  /** AD-2: per-project monotonic. */
  serverSeq: number
}

/**
 * djb2, 32-bit. Cheap change-detection marker — not a cryptographic hash.
 */
export function contentHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

/** Caller hint: which projection tables this event will touch. */
export type ProjectionTouches = 'cells' | 'cell_validators' | 'files'

/**
 * Apply one event to the projection (without the AD-2 sibling guard — the
 * caller is responsible for that). Adds D1PreparedStatements to `stmts`
 * so the caller can batch many events into one db.batch() call.
 *
 * The returned `touches` list lets the route layer compute the
 * `projection.dirty` broadcast payload.
 */
export function buildEventProjectionStmts(
  db: D1Database,
  event: PersistedEvent,
  stmts: D1PreparedStatement[],
): ProjectionTouches[] {
  switch (event.kind) {
    case 'source.cell.create':
    case 'target.cell.create': {
      const p = event.payload as EventPayloads['source.cell.create'] | EventPayloads['target.cell.create']
      if (!event.fileId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId`)
      }
      // payload.cellId is canonical for create events; fall back to envelope cellId
      const cellId = p.cellId ?? event.cellId
      if (!cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing cellId`)
      }
      const side: 'source' | 'target' =
        event.kind === 'source.cell.create' ? 'source' : 'target'
      const value = p.value ?? ''
      const valueHtml = p.valueHtml ?? null
      const type = p.type ?? null
      const canonicalRef =
        event.kind === 'source.cell.create'
          ? ((p as EventPayloads['source.cell.create']).canonicalRef ?? null)
          : null
      const anchorCellId = p.anchorCellId ?? null
      const hash = contentHash(value)
      const wordCount = countWords(value)

      // Both create kinds are genesis events on the cell's chain — their
      // event_id IS the new row's chain head. source_event_id is null on
      // both sides at create time; target commits set it later.
      stmts.push(
        db
          .prepare(
            `INSERT INTO cells (
              project_id, file_id, cell_id, side, value, value_html, type,
              canonical_ref, anchor_cell_id, event_id, source_event_id,
              last_editor, last_edit_at, validated, word_count, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)
            ON CONFLICT(project_id, file_id, cell_id, side) DO UPDATE SET
              side           = excluded.side,
              value          = excluded.value,
              value_html     = excluded.value_html,
              type           = excluded.type,
              canonical_ref  = excluded.canonical_ref,
              anchor_cell_id = excluded.anchor_cell_id,
              event_id       = excluded.event_id,
              source_event_id = NULL,
              last_editor    = excluded.last_editor,
              last_edit_at   = excluded.last_edit_at,
              word_count     = excluded.word_count,
              content_hash   = excluded.content_hash`,
          )
          .bind(
            event.projectId,
            event.fileId,
            cellId,
            side,
            value,
            valueHtml,
            type,
            canonicalRef,
            anchorCellId,
            event.id,
            event.author,
            event.serverTs,
            wordCount,
            hash,
          ),
      )
      return ['cells']
    }

    case 'source.cell.commit':
    case 'target.cell.commit': {
      const p = event.payload as EventPayloads['source.cell.commit'] | EventPayloads['target.cell.commit']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      const value = p.value ?? ''
      const valueHtml = p.valueHtml ?? null
      const hash = contentHash(value)
      const wordCount = countWords(value)

      if (event.kind === 'target.cell.commit') {
        const tp = p as EventPayloads['target.cell.commit']
        const sourceEventId = tp.sourceEventId ?? null

        // For target commits we upsert the target-side row and pin
        // `source_event_id` from the payload. The first human edit often
        // arrives before a target row exists, so the insert path copies
        // type/anchor metadata from the source row for stable ordering.
        // `event_id` advances to this event id (chain head). The
        // `validated` flag resets to 0 because the chain head moved —
        // validators targeting the prior edit are no longer "current".
        // A subsequent cell.validate against this new event_id will flip
        // it back on.
        stmts.push(
          db
            .prepare(
            `INSERT INTO cells (
              project_id, file_id, cell_id, side, value, value_html, type,
              canonical_ref, anchor_cell_id, event_id, source_event_id,
              last_editor, last_edit_at, validated, word_count, content_hash
            ) VALUES (
              ?, ?, ?, 'target', ?, ?,
              (SELECT type FROM cells
                WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'),
              NULL,
              (SELECT anchor_cell_id FROM cells
                WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'),
              ?, ?, ?, ?, 0, ?, ?
            )
            ON CONFLICT(project_id, file_id, cell_id, side) DO UPDATE SET
              value           = excluded.value,
              value_html      = excluded.value_html,
              event_id        = excluded.event_id,
              source_event_id = excluded.source_event_id,
              last_editor     = excluded.last_editor,
              last_edit_at    = excluded.last_edit_at,
              word_count      = excluded.word_count,
              content_hash    = excluded.content_hash,
              validated       = 0`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              value,
              valueHtml,
              event.projectId,
              event.fileId,
              event.cellId,
              event.projectId,
              event.fileId,
              event.cellId,
              event.id,
              sourceEventId,
              event.author,
              event.serverTs,
              wordCount,
              hash,
            ),
        )
      } else {
        // source.cell.commit — same as target but no source_event_id pin
        // (it's null on source-side rows by definition). Source-side
        // validations aren't a v1 concept, so `validated` is left alone
        // here — for source-side rows it stays at its initial 0 forever.
        stmts.push(
          db
            .prepare(
              `UPDATE cells SET
                value         = ?,
                value_html    = ?,
                event_id      = ?,
                last_editor   = ?,
                last_edit_at  = ?,
                word_count    = ?,
                content_hash  = ?
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
            )
            .bind(
              value,
              valueHtml,
              event.id,
              event.author,
              event.serverTs,
              wordCount,
              hash,
              event.projectId,
              event.fileId,
              event.cellId,
            ),
        )
      }
      return ['cells']
    }

    case 'source.cell.delete':
    case 'target.cell.delete': {
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      // Cell row leaves the projection; events stay queryable.
      const side = event.kind === 'source.cell.delete' ? 'source' : 'target'
      stmts.push(
        db
          .prepare(
            `DELETE FROM cells
             WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ?`,
          )
          .bind(event.projectId, event.fileId, event.cellId, side),
      )
      return ['cells']
    }

    case 'source.cell.reorder':
    case 'target.cell.reorder': {
      const p = event.payload as EventPayloads['source.cell.reorder'] | EventPayloads['target.cell.reorder']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      const side = event.kind === 'source.cell.reorder' ? 'source' : 'target'
      stmts.push(
        db
          .prepare(
            `UPDATE cells SET
              anchor_cell_id = ?,
              event_id       = ?,
              last_editor    = ?,
              last_edit_at   = ?
            WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ?`,
          )
          .bind(
            p.anchorCellId ?? null,
            event.id,
            event.author,
            event.serverTs,
            event.projectId,
            event.fileId,
            event.cellId,
            side,
          ),
      )
      return ['cells']
    }

    case 'cell.validate':
    case 'cell.unvalidate': {
      const p = event.payload as EventPayloads['cell.validate']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      const isActive = event.kind === 'cell.validate' ? 1 : 0

      stmts.push(
        db
          .prepare(
            `INSERT INTO cell_validators (
              project_id, file_id, cell_id, edit_event_id, username,
              is_active, decided_ts
            ) VALUES (?, ?, ?, ?, ?, ${isActive}, ?)
            ON CONFLICT(project_id, file_id, cell_id, edit_event_id, username)
            DO UPDATE SET
              is_active  = excluded.is_active,
              decided_ts = excluded.decided_ts
            WHERE excluded.decided_ts > cell_validators.decided_ts`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            p.editEventId,
            event.author,
            event.serverTs,
          ),
      )

      // Recompute the denormalized `cells.validated` flag against the
      // CURRENT chain head (`cells.event_id`). Validating an old edit no
      // longer marks a freshly-committed cell as approved — matching the
      // intent of AD-2 (the chain head is the only state that's "current").
      stmts.push(
        db
          .prepare(
            `UPDATE cells
            SET validated = (
              SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END
              FROM cell_validators
              WHERE project_id = ?
                AND file_id    = ?
                AND cell_id    = ?
                AND is_active  = 1
                AND edit_event_id = cells.event_id
            )
            WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            event.projectId,
            event.fileId,
            event.cellId,
          ),
      )
      return ['cell_validators', 'cells']
    }

    case 'file.create': {
      const p = event.payload as EventPayloads['file.create']
      if (!event.fileId) {
        throw new Error(`file.create event ${event.id} is missing fileId`)
      }
      // Counters left at zero on first insert and untouched on conflict —
      // cell commit projections maintain those.
      //
      // Spec §"File" added role/kind/book_code/source_file_id/anchor_file_id/
      // r2_key/import_format/parser_version to the file.create payload. The
      // legacy `file_type` column is kept in sync from
      // `fileType ?? kind ?? role ?? 'codex'` so pre-spec reads stay valid.
      const legacyFileType = p.fileType ?? p.kind ?? p.role ?? 'codex'
      stmts.push(
        db
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
            p.name,
            legacyFileType,
            p.sourceLanguage ?? null,
            p.targetLanguage ?? null,
            `event:${event.id}`,
            p.role ?? null,
            p.kind ?? null,
            p.bookCode ?? null,
            p.sourceFileId ?? null,
            p.anchorFileId ?? null,
            p.r2Key ?? null,
            p.importFormat ?? null,
            p.parserVersion ?? null,
          ),
      )
      return ['files']
    }

    default: {
      // Defensive exhaustiveness check. If a new EventKind is added without
      // a case here this triggers a TS compile error.
      const exhaustiveCheck: never = event.kind
      throw new Error(
        `buildEventProjectionStmts: unknown event kind "${exhaustiveCheck}" (event id: ${event.id})`,
      )
    }
  }
}

/**
 * Set of event kinds that compete for the cell's chain head (advance
 * `cells.event_id`). Validation and file-level events don't move the
 * chain pointer, so they're excluded from the AD-2 guard.
 */
const CHAIN_MUTATING_KINDS = new Set<string>([
  'source.cell.create',
  'source.cell.commit',
  'source.cell.delete',
  'source.cell.reorder',
  'target.cell.create',
  'target.cell.commit',
  'target.cell.delete',
  'target.cell.reorder',
])

/**
 * AD-2 first-child-of-parent guard. Returns true if this event is the
 * winning child for its `(project_id, file_id, cell_id, parent_id)` — that
 * is, no other CHAIN-MUTATING event with the same key has been accepted
 * yet.
 *
 * On `false`, the caller MUST skip the projection update; the event row
 * itself still lands in `events` so per-cell history can surface it.
 *
 * The check is naturally idempotent: replaying the winning event sees
 * its own row as the existing one and still returns true.
 *
 * Genesis events (`parent_id IS NULL`) follow the same rule — the first
 * `*.cell.create` for a (project, file, cell) wins.
 *
 * Validation events (cell.validate / cell.unvalidate) and file-level
 * events bypass the guard entirely (they're caller-skipped).
 */
export async function isWinningChild(
  db: D1Database,
  candidate: PersistedEvent,
): Promise<boolean> {
  if (!candidate.fileId || !candidate.cellId) {
    // File-level events have no chain — always "winning".
    return true
  }

  // Build the SQL with a NULL-aware parent_id predicate. We also filter
  // to chain-mutating kinds so a sibling validation event doesn't block a
  // legitimate commit from advancing the projection. Source-side and
  // target-side rows have independent chains even when they share cell_id.
  const parentIsNull = candidate.parentId === null || candidate.parentId === undefined
  const kindList = [...CHAIN_MUTATING_KINDS].map((k) => `'${k}'`).join(', ')
  const sideLike = candidate.kind.startsWith('target.') ? 'target.%' : 'source.%'
  const sql = parentIsNull
    ? `SELECT id, server_seq FROM events
       WHERE project_id = ? AND file_id = ? AND cell_id = ?
         AND parent_id IS NULL
         AND kind IN (${kindList})
         AND kind LIKE ?
       ORDER BY server_seq ASC, id ASC
       LIMIT 1`
    : `SELECT id, server_seq FROM events
       WHERE project_id = ? AND file_id = ? AND cell_id = ? AND parent_id = ?
         AND kind IN (${kindList})
         AND kind LIKE ?
       ORDER BY server_seq ASC, id ASC
       LIMIT 1`

  const stmt = parentIsNull
    ? db.prepare(sql).bind(candidate.projectId, candidate.fileId, candidate.cellId, sideLike)
    : db.prepare(sql).bind(candidate.projectId, candidate.fileId, candidate.cellId, candidate.parentId, sideLike)

  const row = await stmt.first<{ id: string; server_seq: number }>()

  // No existing event yet → this one is the first child, wins.
  if (!row) return true

  // The earliest-seq winner is this candidate → idempotent replay.
  if (row.id === candidate.id) return true

  // Some chain-mutating sibling beat us to the chain slot — stale branch.
  return false
}
