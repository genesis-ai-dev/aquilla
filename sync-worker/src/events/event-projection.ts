// Pure function: read one persisted event, emit D1PreparedStatements that
// update the projection tables (cells, cell_validators). Callers batch the
// returned statements via db.batch() for a single D1 round-trip.
//
// Hash function: djb2 (32-bit), matching the existing hashDjb2 in projection.ts.
// Using the same scheme keeps content_hash values identical whether the row was
// last written by the live Y.Doc path or the event-replay path.

import type { EventKind, EventPayloads } from './types'

// A single event row as read from D1's `events` table. JSON.parse is the
// caller's responsibility — `payload` here is already an object.
export interface PersistedEvent<K extends EventKind = EventKind> {
  id: string
  schemaVersion: number
  projectId: string
  fileId: string | null
  cellId: string | null
  kind: K
  author: string
  payload: unknown      // narrowed via kind in handler
  clientTs: number
  serverTs: number
}

/**
 * djb2, 32-bit. Cheap change-detection marker — not a cryptographic hash.
 * Intentionally identical to hashDjb2 in projection.ts so that content_hash
 * values written by both paths are comparable without a migration.
 */
export function contentHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Apply one event to the projection. Idempotent — replaying the same event
 * twice is safe because the writes are guarded:
 *   - cells: UPSERT guarded by last_edit_at (existing pattern from projection.ts)
 *   - cell_validators: UPSERT with LWW on decided_ts
 *
 * Adds D1PreparedStatement instances to the `stmts` array so the caller can
 * batch many events into one db.batch() call.
 */
export function buildEventProjectionStmts(
  db: D1Database,
  event: PersistedEvent,
  stmts: D1PreparedStatement[],
): void {
  switch (event.kind) {
    case 'cell.commit': {
      const p = event.payload as EventPayloads['cell.commit']
      const text = p.value
      const hash = contentHash(text)
      const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length

      if (!event.fileId || !event.cellId) {
        throw new Error(
          `cell.commit event ${event.id} is missing fileId or cellId`,
        )
      }

      // Mirror the UPSERT pattern in projection.ts writeProjection, guarded by
      // last_edit_at so out-of-order replay doesn't clobber newer data.
      stmts.push(
        db
          .prepare(
            `INSERT INTO cells (
              file_id, cell_id, content_text, content_hash, validated,
              word_count, last_editor, last_edit_at, projected_from
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
            ON CONFLICT(file_id, cell_id) DO UPDATE SET
              content_text   = excluded.content_text,
              content_hash   = excluded.content_hash,
              validated      = excluded.validated,
              word_count     = excluded.word_count,
              last_editor    = excluded.last_editor,
              last_edit_at   = excluded.last_edit_at,
              projected_from = excluded.projected_from
            WHERE excluded.last_edit_at > cells.last_edit_at`,
          )
          .bind(
            event.fileId,
            event.cellId,
            text,
            hash,
            wordCount,
            event.author,
            event.serverTs,
            `event:${event.id}`,
          ),
      )
      break
    }

    case 'cell.validate': {
      const p = event.payload as EventPayloads['cell.validate']

      if (!event.fileId || !event.cellId) {
        throw new Error(
          `cell.validate event ${event.id} is missing fileId or cellId`,
        )
      }

      /**
       * Emits TWO statements: the validator UPSERT and a recompute of
       * cells.validated. The second reads from cell_validators after the first
       * lands (D1 batch executes statements sequentially).
       *
       * UPSERT with LWW on decided_ts. is_active=1 means approval stands.
       */
      stmts.push(
        db
          .prepare(
            `INSERT INTO cell_validators (
              project_id, file_id, cell_id, edit_event_id, username,
              is_active, decided_ts
            ) VALUES (?, ?, ?, ?, ?, 1, ?)
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
      // Recompute the denormalized cells.validated flag from active validator state.
      stmts.push(
        db
          .prepare(
            `UPDATE cells
            SET validated = (
              SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END
              FROM cell_validators
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND is_active = 1
            )
            WHERE file_id = ? AND cell_id = ?`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            event.fileId,
            event.cellId,
          ),
      )
      break
    }

    case 'cell.unvalidate': {
      const p = event.payload as EventPayloads['cell.unvalidate']

      if (!event.fileId || !event.cellId) {
        throw new Error(
          `cell.unvalidate event ${event.id} is missing fileId or cellId`,
        )
      }

      /**
       * Emits TWO statements: the validator UPSERT and a recompute of
       * cells.validated. The second reads from cell_validators after the first
       * lands (D1 batch executes statements sequentially).
       *
       * Same as validate but is_active=0 (revocation).
       */
      stmts.push(
        db
          .prepare(
            `INSERT INTO cell_validators (
              project_id, file_id, cell_id, edit_event_id, username,
              is_active, decided_ts
            ) VALUES (?, ?, ?, ?, ?, 0, ?)
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
      // Recompute the denormalized cells.validated flag from active validator state.
      stmts.push(
        db
          .prepare(
            `UPDATE cells
            SET validated = (
              SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END
              FROM cell_validators
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND is_active = 1
            )
            WHERE file_id = ? AND cell_id = ?`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            event.fileId,
            event.cellId,
          ),
      )
      break
    }

    case 'cell.metadata.set': {
      // Phase 0 no-op. The `cells` projection schema doesn't yet have dedicated
      // columns for the cell metadata fields managed by this event (e.g.
      // cellLabel, sourceLocation). Those fields live in the Y.Doc for now and
      // will be migrated to D1 columns in Phase 4. When Phase 4 lands, add an
      // UPDATE cells SET <field> = ? WHERE file_id = ? AND cell_id = ? here.
      break
    }

    case 'thread.add':
    case 'thread.resolve': {
      // Phase 0 no-op. There is no `threads` projection table yet. Thread
      // data will be added in a future phase. When a threads table lands,
      // add UPSERT logic here that writes the thread state.
      break
    }

    default: {
      // Defensive exhaustiveness check. TypeScript narrows `event.kind` to
      // `never` here if all EventKind variants are handled above — a compile-
      // time signal that this runtime branch is unreachable in well-typed code.
      // At runtime (e.g. a newer client sending a kind this worker doesn't know
      // about) we fail loudly so the rebuild endpoint returns 500 rather than
      // silently mis-projecting.
      const exhaustiveCheck: never = event.kind
      throw new Error(
        `buildEventProjectionStmts: unknown event kind "${exhaustiveCheck}" (event id: ${event.id})`,
      )
    }
  }
}
