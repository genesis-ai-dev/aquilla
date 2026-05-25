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
export type ProjectionTouches = 'cells' | 'cell_validators' | 'files' | 'cell_audio'

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
            ON CONFLICT(project_id, file_id, cell_id) DO UPDATE SET
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

        // For target commits we update value-level fields and pin
        // `source_event_id` from the payload. We don't touch side / type /
        // anchor here — they were set by the preceding *.create event.
        // `event_id` advances to this event id (chain head). The
        // `validated` flag resets to 0 because the chain head moved —
        // validators targeting the prior edit are no longer "current".
        // A subsequent cell.validate against this new event_id will flip
        // it back on.
        stmts.push(
          db
            .prepare(
              `UPDATE cells SET
                value           = ?,
                value_html      = ?,
                event_id        = ?,
                source_event_id = ?,
                last_editor     = ?,
                last_edit_at    = ?,
                word_count      = ?,
                content_hash    = ?,
                validated       = 0
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'`,
            )
            .bind(
              value,
              valueHtml,
              event.id,
              sourceEventId,
              event.author,
              event.serverTs,
              wordCount,
              hash,
              event.projectId,
              event.fileId,
              event.cellId,
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
      // Only the side this event targets — the opposite side stays put.
      const side = event.kind === 'target.cell.delete' ? 'target' : 'source'
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
      const side = event.kind === 'target.cell.reorder' ? 'target' : 'source'
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

      // DELETE-on-unvalidate (spec §"Validator record"): a row exists iff
      // the validator currently endorses the cell. `cell.validate` upserts
      // one row per (cell, validator) carrying the validated commit's
      // `event_id`; `cell.unvalidate` deletes it. The decided_ts guard keeps
      // out-of-order replays from clobbering a newer decision.
      if (event.kind === 'cell.validate') {
        stmts.push(
          db
            .prepare(
              `INSERT INTO cell_validators (
                project_id, file_id, cell_id, event_id, username, decided_ts
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(project_id, file_id, cell_id, username)
              DO UPDATE SET
                event_id   = excluded.event_id,
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
      } else {
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_validators
                WHERE project_id = ? AND file_id = ? AND cell_id = ? AND username = ?`,
            )
            .bind(event.projectId, event.fileId, event.cellId, event.author),
        )
      }

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
                AND event_id   = cells.event_id
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

case 'cell.audio.attach': {
      const p = event.payload as EventPayloads['cell.audio.attach']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      // Deselect any other clip in the same slot, then upsert this one as the
      // selected, live clip. `audio_id != ?` so the deselect never touches the
      // row we're about to (re)insert as selected.
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET selected = 0
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND slot = ? AND audio_id != ?`,
          )
          .bind(event.projectId, event.fileId, event.cellId, p.slot, p.audioId),
      )
      stmts.push(
        db
          .prepare(
            `INSERT INTO cell_audio (
              project_id, file_id, cell_id, audio_id, slot, url, mime_type,
              voice_id, reference_audio_id, duration_ms, timings_json,
              selected, deleted, event_id, created_ts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            ON CONFLICT(project_id, file_id, cell_id, audio_id) DO UPDATE SET
              slot               = excluded.slot,
              url                = excluded.url,
              mime_type          = excluded.mime_type,
              voice_id           = excluded.voice_id,
              reference_audio_id = excluded.reference_audio_id,
              duration_ms        = excluded.duration_ms,
              timings_json       = excluded.timings_json,
              selected           = 1,
              deleted            = 0,
              event_id           = excluded.event_id`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            p.audioId,
            p.slot,
            p.url,
            p.mimeType ?? null,
            p.voiceId ?? null,
            p.referenceAudioId ?? null,
            p.durationMs ?? null,
            p.timings ? JSON.stringify(p.timings) : null,
            event.id,
            event.serverTs,
          ),
      )
      return ['cell_audio']
    }

    case 'cell.audio.select': {
      const p = event.payload as EventPayloads['cell.audio.select']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET selected = 0
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND slot = ? AND audio_id != ?`,
          )
          .bind(event.projectId, event.fileId, event.cellId, p.slot, p.audioId),
      )
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET selected = 1, deleted = 0
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?`,
          )
          .bind(event.projectId, event.fileId, event.cellId, p.audioId),
      )
      return ['cell_audio']
    }

    case 'cell.audio.remove': {
      const p = event.payload as EventPayloads['cell.audio.remove']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      // Soft-delete + deselect. The next live clip is NOT auto-promoted; the
      // client emits an explicit cell.audio.select to switch.
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET deleted = 1, selected = 0
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?`,
          )
          .bind(event.projectId, event.fileId, event.cellId, p.audioId),
      )
      return ['cell_audio']
    }
    case 'file.create': {
      const p = event.payload as EventPayloads['file.create']
      if (!event.fileId) {
        throw new Error(`file.create event ${event.id} is missing fileId`)
      }
      // Counters left at zero on first insert and untouched on conflict —
      // cell commit projections maintain those. Post-0012 schema: file_type
      // collapsed into role/kind; languages live in meta (JSON); event_id is
      // this file.create's id (NOT NULL AD-2 chain head).
      const langMeta: Record<string, string> = {}
      if (p.sourceLanguage) langMeta.sourceLanguage = p.sourceLanguage
      if (p.targetLanguage) langMeta.targetLanguage = p.targetLanguage
      stmts.push(
        db
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
              ?, unixepoch('now') * 1000, unixepoch('now') * 1000,
              ?
            )
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              kind = excluded.kind,
              event_id = excluded.event_id,
              meta = excluded.meta,
              updated_at = unixepoch('now') * 1000`,
          )
          .bind(
            event.fileId,
            event.projectId,
            p.name,
            p.fileType ?? null,
            event.id,
            event.author,
            JSON.stringify(langMeta),
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
  // legitimate commit from advancing the projection.
  const parentIsNull = candidate.parentId === null || candidate.parentId === undefined
  const kindList = [...CHAIN_MUTATING_KINDS].map((k) => `'${k}'`).join(', ')
  const sql = parentIsNull
    ? `SELECT id, server_seq FROM events
       WHERE project_id = ? AND file_id = ? AND cell_id = ?
         AND parent_id IS NULL
         AND kind IN (${kindList})
       ORDER BY server_seq ASC, id ASC
       LIMIT 1`
    : `SELECT id, server_seq FROM events
       WHERE project_id = ? AND file_id = ? AND cell_id = ? AND parent_id = ?
         AND kind IN (${kindList})
       ORDER BY server_seq ASC, id ASC
       LIMIT 1`

  const stmt = parentIsNull
    ? db.prepare(sql).bind(candidate.projectId, candidate.fileId, candidate.cellId)
    : db.prepare(sql).bind(candidate.projectId, candidate.fileId, candidate.cellId, candidate.parentId)

  const row = await stmt.first<{ id: string; server_seq: number }>()

  // No existing event yet → this one is the first child, wins.
  if (!row) return true

  // The earliest-seq winner is this candidate → idempotent replay.
  if (row.id === candidate.id) return true

  // Some chain-mutating sibling beat us to the chain slot — stale branch.
  return false
}
