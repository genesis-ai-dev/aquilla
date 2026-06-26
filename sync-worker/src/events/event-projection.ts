// Builds SQL statements that advance the `cells` / `cell_validators`
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

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import type { EventKind, EventPayloads, CommentScope } from './types'
import type { ChainSlot } from './chain-claims'
import { ROLE } from './role-policy'

// A single event row as it lives in Postgres. JSON.parse on `payload` is the
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
  /** AD-2: per-project monotonic. Set only on rows that have been read back
   *  from Postgres (read-side paths); write paths leave it undefined because the
   *  value is derived atomically inside the events INSERT, not in JS. */
  serverSeq?: number
  /**
   * Caller's resolved project role level (numeric). Populated by the route
   * from EventClaims.roleLevel so the projection can apply foreign-vs-self
   * enforcement without a separate DB read.
   */
  callerRole?: number
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

// FTS index maintenance: none. Postgres auto-maintains the cells.value_tsv
// generated column + GIN index on every cells write, so the projection emits no
// FTS statements (the old SQLite FTS5 cells_fts shadow-table upkeep is gone).

/**
 * Recompute the denormalized `files` rollup counters from the live `cells`
 * rows for one file. Pushed AFTER the cells DML so the correlated subqueries
 * observe the post-mutation state.
 *
 * Self-healing by design: every cell-mutating event re-derives the counters
 * from scratch, so they converge to the truth regardless of AD-2 chain races,
 * out-of-order delivery, or a replayed event log. Incremental +1/-1 deltas
 * would drift the moment two events raced — the v3 projection is meant to be a
 * pure function of the `cells` table, so we recompute rather than increment.
 *
 * Definitions:
 *   cell_count     — distinct cell positions (paired source/target share an id)
 *   approved_count — validated cells (only target rows ever carry validated=1)
 *   filled_count   — target cells with content (TRIM(value) != ''); the
 *                    "translated / has a draft" signal the chapter dots encode
 *   word_count     — total target-side words (translation output)
 *   last_edit_at   — most recent cell edit on the file (also drives file sort)
 *
 * NOTE: this is what was always meant by file-create's "counters are
 * maintained by the cell commit projection path" comment — that maintenance
 * never actually existed before, so every `files` row sat at cell_count=0.
 */
export function fileCountersRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  serverTs: number,
): AquillaStatement {
  return db
    .prepare(
      `UPDATE files SET
        cell_count = (SELECT COUNT(DISTINCT cell_id) FROM cells WHERE project_id = ? AND file_id = ?),
        approved_count = (SELECT COUNT(*) FROM cells WHERE project_id = ? AND file_id = ? AND validated = 1),
        filled_count = (SELECT COUNT(*) FROM cells WHERE project_id = ? AND file_id = ? AND side = 'target' AND TRIM(value) != ''),
        word_count = (SELECT COALESCE(SUM(word_count), 0) FROM cells WHERE project_id = ? AND file_id = ? AND side = 'target'),
        last_edit_at = (SELECT MAX(last_edit_at) FROM cells WHERE project_id = ? AND file_id = ?),
        ai_drafted_count = (SELECT COUNT(*) FROM cells WHERE project_id = ? AND file_id = ? AND side = 'target' AND ai_drafted = 1),
        updated_at = ?
      WHERE id = ? AND project_id = ?`,
    )
    .bind(
      projectId, fileId,
      projectId, fileId,
      projectId, fileId,
      projectId, fileId,
      projectId, fileId,
      projectId, fileId,
      serverTs,
      fileId, projectId,
    )
}

/**
 * Bulk variant of the `source.cell.create` cells upsert (POST /import fast
 * path) — one multi-row INSERT instead of one statement per cell, because the
 * Postgres shim executes batch statements as sequential round trips. MUST stay
 * column-for-column identical to the single-row insert in
 * buildEventProjectionStmts' source.cell.create case (no chain gate: bulk
 * import is genesis-only, the same ungated shape the route used before).
 *
 * Rows are deduped by (cell_id) keeping the LAST occurrence — Postgres errors
 * on a multi-row ON CONFLICT DO UPDATE touching the same row twice, and
 * last-wins matches what the sequential per-row upserts did.
 */
export function buildBulkSourceCellCreateStmt(
  db: AquillaDb,
  events: PersistedEvent[],
): AquillaStatement {
  if (events.length === 0) throw new Error('buildBulkSourceCellCreateStmt: empty events')
  const byCell = new Map<string, PersistedEvent>()
  for (const event of events) {
    const p = event.payload as EventPayloads['source.cell.create']
    const cellId = p.cellId ?? event.cellId
    if (!event.fileId) throw new Error(`source.cell.create event ${event.id} is missing fileId`)
    if (!cellId) throw new Error(`source.cell.create event ${event.id} is missing cellId`)
    byCell.set(cellId, event)
  }
  const rows = [...byCell.values()]
  const binds: unknown[] = []
  for (const event of rows) {
    const p = event.payload as EventPayloads['source.cell.create']
    const value = p.value ?? ''
    binds.push(
      event.projectId,
      event.fileId,
      p.cellId ?? event.cellId,
      'source',
      value,
      p.valueHtml ?? null,
      p.type ?? null,
      p.canonicalRef ?? null,
      p.anchorCellId ?? null,
      event.id,
      event.author,
      event.serverTs,
      countWords(value),
      contentHash(value),
      p.startMs ?? null,
      p.endMs ?? null,
      p.medium ?? null,
      p.sequenceIndex ?? null,
      p.transcription ?? null,
      p.cameraState ?? null,
      // OBS parity: extensible per-cell metadata bucket, JSON-encoded for JSONB.
      p.metadata != null ? JSON.stringify(p.metadata) : null,
    )
  }
  const placeholders = Array(rows.length)
    .fill('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .join(',\n')
  return db
    .prepare(
      `INSERT INTO cells (
        project_id, file_id, cell_id, side, value, value_html, type,
        canonical_ref, anchor_cell_id, event_id, source_event_id,
        last_editor, last_edit_at, validated, word_count, content_hash,
        start_ms, end_ms,
        medium, sequence_index, transcription, camera_state, metadata
      ) VALUES ${placeholders}
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
        content_hash   = excluded.content_hash,
        start_ms       = excluded.start_ms,
        end_ms         = excluded.end_ms,
        medium         = excluded.medium,
        sequence_index = excluded.sequence_index,
        transcription  = excluded.transcription,
        camera_state   = excluded.camera_state,
        metadata       = excluded.metadata`,
    )
    .bind(...binds)
}

/** Caller hint: which projection tables this event will touch. */
export type ProjectionTouches = 'cells' | 'cell_validators' | 'cell_waivers' | 'files' | 'cell_audio' | 'comments' | 'cell_backtranslations'

/**
 * Apply one event to the projection (without the AD-2 sibling guard — the
 * caller is responsible for that). Adds D1PreparedStatements to `stmts`
 * so the caller can batch many events into one db.batch() call.
 *
 * The returned `touches` list lets the route layer compute the
 * `projection.dirty` broadcast payload.
 */
export function buildEventProjectionStmts(
  db: AquillaDb,
  event: PersistedEvent,
  stmts: AquillaStatement[],
  opts?: {
    deferFileCounters?: boolean
    /**
     * AD-2 atomic arbitration (RACE-2): when set, every chain-advancing
     * `cells` write is gated on this event holding the chain_claims row for
     * `chainGate` (see chain-claims.ts). The live route passes the slot it
     * claimed; rebuild/import arbitrate winners themselves and leave this
     * unset (ungated writes, identical to the previous behavior).
     */
    chainGate?: ChainSlot
    /**
     * FRO-279: project-level threshold for cells.validated.
     * `cells.validated` flips to 1 when the cell has at least this many
     * current-head validators. Default 1 (N=1 projects: byte-identical behavior).
     */
    validationCount?: number
  },
): ProjectionTouches[] {
  // Gate fragments for chain-advancing cells writes. `gateWhere` suffixes an
  // INSERT…SELECT row source; `gateAnd` extends an UPDATE/DELETE WHERE.
  const gate = opts?.chainGate
  const GATE_EXISTS =
    'EXISTS (SELECT 1 FROM chain_claims WHERE project_id = ? AND file_id = ? AND cell_id = ? AND parent_key = ? AND event_id = ?)'
  const gateWhere = gate ? ` WHERE ${GATE_EXISTS}` : ''
  const gateAnd = gate ? ` AND ${GATE_EXISTS}` : ''
  const gateBinds: unknown[] = gate
    ? [gate.projectId, gate.fileId, gate.cellId, gate.parentKey, event.id]
    : []

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
      const startMs = p.startMs ?? null
      const endMs = p.endMs ?? null
      // Timeline-segment-model (Scope A): segment metadata is set at create
      // time (by import or a media-segment add) and, like start_ms/end_ms, is
      // not overwritten by later target commits.
      const medium = p.medium ?? null
      const sequenceIndex = p.sequenceIndex ?? null
      const transcription = p.transcription ?? null
      const cameraState = p.cameraState ?? null
      // OBS parity: extensible per-cell metadata bucket. JSON-encode for the
      // JSONB column (the driver binds a text param; Postgres casts it into
      // JSONB). NULL when the create event carries no metadata.
      const metadata =
        'metadata' in p && p.metadata != null ? JSON.stringify(p.metadata) : null

      // Both create kinds are genesis events on the cell's chain — their
      // event_id IS the new row's chain head. source_event_id is null on
      // both sides at create time; target commits set it later.
      //
      // NOTE: buildBulkSourceCellCreateStmt (above) mirrors this insert for
      // the bulk-import path — change them together.

      // FTS5 maintenance (pre-DML): delete the old indexed value if a cells
      // row already exists for this key. No-op when this is a genuine first
      // insert.

      stmts.push(
        db
          .prepare(
            `INSERT INTO cells (
              project_id, file_id, cell_id, side, value, value_html, type,
              canonical_ref, anchor_cell_id, event_id, source_event_id,
              last_editor, last_edit_at, validated, word_count, content_hash,
              start_ms, end_ms,
              medium, sequence_index, transcription, camera_state, metadata
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?${gateWhere}
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
              content_hash   = excluded.content_hash,
              start_ms       = excluded.start_ms,
              end_ms         = excluded.end_ms,
              medium         = excluded.medium,
              sequence_index = excluded.sequence_index,
              transcription  = excluded.transcription,
              camera_state   = excluded.camera_state,
              metadata       = excluded.metadata`,
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
            startMs,
            endMs,
            medium,
            sequenceIndex,
            transcription,
            cameraState,
            metadata,
            ...gateBinds,
          ),
      )

      // FTS5 maintenance (post-DML): insert the new value now that the cells
      // row reflects the post-create/update state.

      if (!opts?.deferFileCounters)
        stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
      return ['cells', 'files']
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

      // FTS5 maintenance (pre-DML): remove the OLD indexed value before we
      // overwrite the cells row. Must run first so the old value is still
      // readable from `cells`.

      if (event.kind === 'target.cell.commit') {
        const tp = p as EventPayloads['target.cell.commit']
        const sourceEventId = tp.sourceEventId ?? null
        // FRO-292: set ai_drafted=1 when the commit carries ai_suggestion, clear to 0
        // on any human commit (ai_suggestion absent). Human edit reclassifies the cell.
        const aiDrafted = tp.ai_suggestion ? 1 : 0

        // NOTE: start_ms/end_ms are intentionally NOT written here — they are set once at
        // *.cell.create time and never overwritten by target commits.
        //
        // UPSERT, not UPDATE: the client never emits `target.cell.create` —
        // the first translation of a cell arrives straight as a
        // `target.cell.commit`, and import only seeds source-side rows. A
        // plain UPDATE ... WHERE side='target' would match zero rows and the
        // translation would be silently lost (the event still 200-accepts but
        // never projects). So the first commit INSERTs the target row;
        // subsequent commits hit ON CONFLICT and UPDATE it. `side` is the
        // literal 'target'; type/canonical_ref/anchor have no source on a
        // target row created this way (null). `event_id` is the chain head;
        // `validated` resets to 0 because the chain head moved — a later
        // cell.validate against this new event_id flips it back on. Columns
        // mirror the create-path INSERT so the NOT NULL set is satisfied.
        stmts.push(
          db
            .prepare(
              `INSERT INTO cells (
                project_id, file_id, cell_id, side, value, value_html, type,
                canonical_ref, anchor_cell_id, event_id, source_event_id,
                last_editor, last_edit_at, validated, word_count, content_hash,
                ai_drafted
              ) SELECT ?, ?, ?, 'target', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 0, ?, ?, ?${gateWhere}
              ON CONFLICT(project_id, file_id, cell_id, side) DO UPDATE SET
                value             = excluded.value,
                value_html        = excluded.value_html,
                event_id          = excluded.event_id,
                source_event_id   = excluded.source_event_id,
                last_editor       = excluded.last_editor,
                last_edit_at      = excluded.last_edit_at,
                word_count        = excluded.word_count,
                content_hash      = excluded.content_hash,
                validated         = 0,
                endorsement_count = 0,
                ai_drafted        = excluded.ai_drafted`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              value,
              valueHtml,
              event.id,
              sourceEventId,
              event.author,
              event.serverTs,
              wordCount,
              hash,
              aiDrafted,
              ...gateBinds,
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
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'${gateAnd}`,
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
              ...gateBinds,
            ),
        )
      }

      // FTS5 maintenance (post-DML): insert the new indexed value now that
      // the cells row has been updated/upserted.

      if (!opts?.deferFileCounters)
        stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
      return ['cells', 'files']
    }

    case 'source.cell.delete':
    case 'target.cell.delete': {
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      // Cell row leaves the projection; events stay queryable.
      // Only the side this event targets — the opposite side stays put.
      const side = event.kind === 'target.cell.delete' ? 'target' : 'source'

      // FTS5 maintenance (pre-DML): remove the indexed value BEFORE deleting
      // the cells row so the OLD value is still readable for the 'delete'
      // command.

      stmts.push(
        db
          .prepare(
            `DELETE FROM cells
             WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ?${gateAnd}`,
          )
          .bind(event.projectId, event.fileId, event.cellId, side, ...gateBinds),
      )
      if (!opts?.deferFileCounters)
        stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
      return ['cells', 'files']
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
            WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ?${gateAnd}`,
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
            ...gateBinds,
          ),
      )
      if (!opts?.deferFileCounters)
        stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
      return ['cells', 'files']
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
        // cell.unvalidate: delete the validator row.
        //
        // Self path: caller removes their own validation — reviewer(300)+ is
        //   sufficient (already gated by REQUIRED_ROLE in role-policy.ts).
        // Foreign path: payload.targetUsername is set to a different user —
        //   caller MUST be maintainer(600)+.  The route layer rejects the
        //   event before it reaches here if the role is insufficient, so by
        //   the time we land in the projection we can trust the role check
        //   has passed and just use targetUsername as the deletion key.
        const up = event.payload as EventPayloads['cell.unvalidate']
        const targetUsername =
          up.targetUsername && up.targetUsername !== event.author
            ? up.targetUsername
            : event.author
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_validators
                WHERE project_id = ? AND file_id = ? AND cell_id = ? AND username = ?`,
            )
            .bind(event.projectId, event.fileId, event.cellId, targetUsername),
        )
      }

      // FRO-292: validation supersedes AI-drafted status. Once a reviewer
      // validates a cell, it moves to "Validated" — the "AI-drafted awaiting
      // review" label no longer applies regardless of the commit provenance.
      // Clear ai_drafted = 0 on cell.validate so the file counter reflects
      // that the cell is no longer in the "awaiting review" bucket.
      if (event.kind === 'cell.validate') {
        stmts.push(
          db
            .prepare(
              `UPDATE cells SET ai_drafted = 0
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'`,
            )
            .bind(event.projectId, event.fileId, event.cellId),
        )
      }

      // Recompute the denormalized `cells.validated` flag against the
      // CURRENT chain head (`cells.event_id`). A cell is "validated" when
      // the number of current-head validators meets the project threshold.
      //
      // FRO-279: threshold is `opts.validationCount` (default 1). N=1
      // projects are byte-identical to the old COUNT(*) > 0 behavior.
      // The threshold is bound as a parameter so no SQL string interpolation.
      const validationThreshold = Math.max(1, opts?.validationCount ?? 1)
      stmts.push(
        db
          .prepare(
            `UPDATE cells
            SET validated = (
              SELECT CASE WHEN COUNT(*) >= ? THEN 1 ELSE 0 END
              FROM cell_validators
              WHERE project_id = ?
                AND file_id    = ?
                AND cell_id    = ?
                AND event_id   = cells.event_id
            )
            WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'`,
          )
          .bind(
            validationThreshold,
            event.projectId,
            event.fileId,
            event.cellId,
            event.projectId,
            event.fileId,
            event.cellId,
          ),
      )

      // AD-14 pass 1: endorsement_count = number of validators on the CURRENT
      // chain head. Idempotent under replay (derives from the validators
      // table, not an increment). Resets to 0 on cell.commit because that
      // moves the chain head.
      //
      // TODO(AD-13/14): propagate endorsement to the validated cell's
      // branching-search neighborhood. Today only the directly-validated
      // cell gains health; nearby cells stay at 0 even though the spec says
      // they should pick up partial endorsement. That's the loop that also
      // makes retrieval examples appear for neighbors once a few cells in
      // the region are validated.
      //
      // TODO(realtime): once the neighborhood loop lands it'll dirty many
      // cells per validate. Move from "broadcast event.applied + client
      // re-fetches the changed cell" to "broadcast the row payload itself
      // on the WS frame" (Supabase-realtime style) so the client patches
      // in place with zero round-trip and N-cell-per-event isn't N HTTP
      // requests. The pieces exist — `projection.dirty` is already a
      // defined variant in events/realtime.ts; the coalescer in
      // events/coalescer.ts is the right hook for batching the row reads.
      // This is an app-shaped change (protocol bump on the WS frame,
      // post-commit row read on every projected event, coalescer wiring)
      // so it's deferred behind the immediate single-cell refetch path
      // in src/hooks/useCells.ts → revalidateCell().
      stmts.push(
        db
          .prepare(
            `UPDATE cells
            SET endorsement_count = (
              SELECT COUNT(*)
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
      if (!opts?.deferFileCounters)
        stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
      return ['cell_validators', 'cells', 'files']
    }

    case 'cell.waive':
    case 'cell.unwaive': {
      const p = event.payload as EventPayloads['cell.waive']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }

      // DELETE-on-unwaive (mirrors cell_validators): a row exists iff the rule
      // is currently waived on this cell. `cell.waive` upserts one row per
      // (cell, rule); `cell.unwaive` deletes it. The waived_ts guard keeps an
      // out-of-order replay from clobbering a newer decision. Waivers do not
      // touch cells.event_id or the file counters — they only suppress a QA
      // blot in the client, so no `cells` / `files` recompute here.
      if (event.kind === 'cell.waive') {
        stmts.push(
          db
            .prepare(
              `INSERT INTO cell_waivers (
                project_id, file_id, cell_id, rule_id, reason, waived_by, waived_ts
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(project_id, file_id, cell_id, rule_id)
              DO UPDATE SET
                reason     = excluded.reason,
                waived_by  = excluded.waived_by,
                waived_ts  = excluded.waived_ts
              WHERE excluded.waived_ts > cell_waivers.waived_ts`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              p.ruleId,
              p.reason ?? null,
              event.author,
              event.serverTs,
            ),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_waivers
                WHERE project_id = ? AND file_id = ? AND cell_id = ? AND rule_id = ?`,
            )
            .bind(event.projectId, event.fileId, event.cellId, p.ruleId),
        )
      }

      return ['cell_waivers']
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
              voice_id, reference_audio_id, duration_ms, trim_start_ms, trim_end_ms,
              timings_json, selected, deleted, event_id, created_ts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            ON CONFLICT(project_id, file_id, cell_id, audio_id) DO UPDATE SET
              slot               = excluded.slot,
              url                = excluded.url,
              mime_type          = excluded.mime_type,
              voice_id           = excluded.voice_id,
              reference_audio_id = excluded.reference_audio_id,
              duration_ms        = excluded.duration_ms,
              trim_start_ms      = excluded.trim_start_ms,
              trim_end_ms        = excluded.trim_end_ms,
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
            p.trimStartMs ?? null,
            p.trimEndMs ?? null,
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
      // Timeline-segment-model: the file's order lens lives in meta (JSON),
      // alongside languages — no files-table column needed.
      if (p.orderedBy) langMeta.orderedBy = p.orderedBy
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
            p.name,
            p.fileType ?? null,
            event.id,
            event.author,
            JSON.stringify(langMeta),
          ),
      )
      return ['files']
    }

    case 'file.rename': {
      const p = event.payload as EventPayloads['file.rename']
      if (!event.fileId) {
        throw new Error(`file.rename event ${event.id} is missing fileId`)
      }
      // Replay-safe label update: new name + AD-2 chain head. Mirrors
      // handlers/file-rename.ts (the live dispatch path). Structural columns,
      // language meta, and counters are intentionally left untouched.
      stmts.push(
        db
          .prepare(
            `UPDATE files
                SET name = ?, event_id = ?, updated_at = (extract(epoch from now()) * 1000)::bigint
              WHERE id = ? AND project_id = ?`,
          )
          .bind(p.name, event.id, event.fileId, event.projectId),
      )
      return ['files']
    }

    case 'file.delete': {
      // FRO-272: replay-safe soft-delete tombstone. Mirrors handlers/file-delete-restore.ts.
      // Idempotent on double-delete (WHERE deleted_at IS NULL).
      if (!event.fileId) {
        throw new Error(`file.delete event ${event.id} is missing fileId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE files
                SET deleted_at = ?, updated_at = (extract(epoch from now()) * 1000)::bigint
              WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
          )
          .bind(event.serverTs, event.fileId, event.projectId),
      )
      return ['files']
    }

    case 'file.restore': {
      // FRO-272: replay-safe restore. Mirrors handlers/file-delete-restore.ts.
      // Idempotent on double-restore (WHERE deleted_at IS NOT NULL).
      if (!event.fileId) {
        throw new Error(`file.restore event ${event.id} is missing fileId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE files
                SET deleted_at = NULL, updated_at = (extract(epoch from now()) * 1000)::bigint
              WHERE id = ? AND project_id = ? AND deleted_at IS NOT NULL`,
          )
          .bind(event.fileId, event.projectId),
      )
      return ['files']
    }

    case 'comment.create': {
      const p = event.payload as EventPayloads['comment.create']
      const scope: CommentScope = p.scope
      const scopeKind = scope.kind
      const fileId = scopeKind === 'cell' ? scope.fileId : scopeKind === 'file' ? scope.fileId : null
      const cellId = scopeKind === 'cell' ? scope.cellId : null
      stmts.push(
        db
          .prepare(
            `INSERT INTO comments (
              comment_id, project_id, scope_kind, file_id, cell_id,
              parent_comment_id, body, resolved, author_id, author_label,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL)
            ON CONFLICT(comment_id) DO NOTHING`,
          )
          .bind(
            p.commentId,
            event.projectId,
            scopeKind,
            fileId,
            cellId,
            p.parentCommentId,
            p.body,
            event.author,
            event.author,
            event.serverTs,
            event.serverTs,
          ),
      )
      return ['comments']
    }

    case 'comment.edit': {
      const p = event.payload as EventPayloads['comment.edit']
      // Self path: author_id check restricts edit to own comment.
      // Maintainer+ foreign path: author_id check dropped so they can edit
      //   any comment. The route layer has already rejected the event if the
      //   caller is not the author AND does not have maintainer(600)+ role.
      const isMaintainer = (event.callerRole ?? 0) >= ROLE.MAINTAINER
      if (isMaintainer) {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = ?, updated_at = ?
               WHERE comment_id = ? AND deleted_at IS NULL`,
            )
            .bind(p.body, event.serverTs, p.commentId),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = ?, updated_at = ?
               WHERE comment_id = ? AND author_id = ? AND deleted_at IS NULL`,
            )
            .bind(p.body, event.serverTs, p.commentId, event.author),
        )
      }
      return ['comments']
    }

    case 'comment.delete': {
      const p = event.payload as EventPayloads['comment.delete']
      // Soft-delete: preserve the row so threads remain navigable.
      // Body cleared; deleted_at set. UI renders "[deleted]".
      // Maintainer+ foreign path: author_id check dropped (same logic as edit).
      const isMaintainer = (event.callerRole ?? 0) >= ROLE.MAINTAINER
      if (isMaintainer) {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = '', deleted_at = ?, updated_at = ?
               WHERE comment_id = ? AND deleted_at IS NULL`,
            )
            .bind(event.serverTs, event.serverTs, p.commentId),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = '', deleted_at = ?, updated_at = ?
               WHERE comment_id = ? AND author_id = ? AND deleted_at IS NULL`,
            )
            .bind(event.serverTs, event.serverTs, p.commentId, event.author),
        )
      }
      return ['comments']
    }

    case 'comment.resolve': {
      const p = event.payload as EventPayloads['comment.resolve']
      // Only resolve top-level comments (parent_comment_id IS NULL).
      // Server noops on a reply id per spec.
      //
      // Self path: comment author resolves their own thread — commenter(200)+.
      // Foreign path: resolving someone else's thread — maintainer(600)+ only.
      //   The route layer rejects the event before it reaches here when the
      //   caller is not the comment author and lacks maintainer role. The
      //   projection logic is the same either way (no author filter on resolve
      //   — ownership was already enforced upstream).
      stmts.push(
        db
          .prepare(
            `UPDATE comments SET resolved = ?, updated_at = ?
             WHERE comment_id = ? AND parent_comment_id IS NULL AND deleted_at IS NULL`,
          )
          .bind(p.resolved ? 1 : 0, event.serverTs, p.commentId),
      )
      return ['comments']
    }

    case 'cell.backtranslation.set': {
      // Non-chain-mutating: does NOT move cells.event_id, does NOT touch
      // cell_validators or endorsement_count. Upserts into cell_backtranslations,
      // keying the latest BT per (project_id, file_id, cell_id). Historical BTs
      // are queryable via the target_event_id key.
      const p = event.payload as EventPayloads['cell.backtranslation.set']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `INSERT INTO cell_backtranslations (
              project_id, file_id, cell_id, target_event_id,
              bt_text, bt_html, polished, author, event_id, server_seq, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, file_id, cell_id, target_event_id) DO UPDATE SET
              bt_text     = excluded.bt_text,
              bt_html     = excluded.bt_html,
              polished    = excluded.polished,
              author      = excluded.author,
              event_id    = excluded.event_id,
              server_seq  = excluded.server_seq,
              created_at  = excluded.created_at`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            p.targetEventId,
            p.btText,
            p.btHtml ?? null,
            p.polished ? 1 : 0,
            event.author,
            event.id,
            event.serverSeq ?? null,
            event.serverTs,
          ),
      )
      return ['cell_backtranslations']
    }

    case 'assignment.create':
    case 'assignment.reassign':
    case 'assignment.unassign': {
      // Assignment projection is built directly in handlers/assignment-events.ts
      // because it needs claims.userId for `created_by` (an INTEGER matching
      // assignee_user_id), which PersistedEvent does not carry — it only has
      // `author` (username). These kinds route to handleAssignmentEvent and
      // never reach this projector; this case exists only for exhaustiveness.
      throw new Error(
        `buildEventProjectionStmts: ${event.kind} is projected by handleAssignmentEvent, not here (event id: ${event.id})`,
      )
    }

    case 'project.link-source': {
      // AD-9: no sync-worker projection needed — projects.source_project_id
      // is owned by auth-worker. dispatch.ts handles this kind directly and
      // never calls buildEventProjectionStmts for it; this case is here for
      // TypeScript exhaustiveness only.
      throw new Error(
        `buildEventProjectionStmts: project.link-source is handled by dispatch.ts, not here (event id: ${event.id})`,
      )
    }

    case 'cast.assign': {
      // FRO-438: non-chain-mutating label assignment. Merges cast_name into
      // cells.metadata JSONB without touching value, event_id, or validated.
      // Applies to the SOURCE-side row (the cell's canonical reference lives
      // on the source side); the same cell_id lookup works for both sides.
      // FRO-439: also updates camera_state column when cameraState is present
      // in the payload, so angle-embedded labels are split cleanly on import.
      const p = event.payload as EventPayloads['cast.assign']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cast.assign event ${event.id} is missing fileId or cellId`)
      }
      if (p.castName !== null && p.castName !== undefined) {
        // Merge into existing JSONB, preserving other metadata keys.
        stmts.push(
          db
            .prepare(
              `UPDATE cells
               SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cast_name', ?::text)
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
            )
            .bind(p.castName, event.projectId, event.fileId, event.cellId),
        )
      } else {
        // Null castName = clear the label.
        stmts.push(
          db
            .prepare(
              `UPDATE cells
               SET metadata = CASE
                 WHEN metadata IS NULL THEN NULL
                 ELSE metadata - 'cast_name'
               END
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
            )
            .bind(event.projectId, event.fileId, event.cellId),
        )
      }
      // FRO-439: optionally update camera_state when the payload carries it.
      // Null clears the column; undefined = not provided = no-op.
      if (p.cameraState !== undefined) {
        stmts.push(
          db
            .prepare(
              `UPDATE cells
               SET camera_state = ?
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
            )
            .bind(p.cameraState, event.projectId, event.fileId, event.cellId),
        )
      }
      return ['cells']
    }

    case 'cell.retime': {
      // Timeline editor: move/stretch. Updates start_ms/end_ms on BOTH sides
      // (timing is a property of the segment, shared by source + target rows).
      // cellId rides on the envelope. Non-chain-mutating (not in CHAIN_MUTATING_KINDS).
      const p = event.payload as EventPayloads['cell.retime']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cell.retime event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE cells
                SET start_ms = ?, end_ms = ?
              WHERE project_id = ? AND file_id = ? AND cell_id = ?`,
          )
          .bind(p.startMs, p.endMs, event.projectId, event.fileId, event.cellId),
      )
      return ['cells']
    }

    case 'file.video.set': {
      // Timeline editor: replay-safe core video URL update. Mirrors the live
      // dispatch path (handlers/file-video-set.ts) via the shared SQL builder,
      // merging/removing coreMediaUrl in files.meta JSON and advancing the
      // file's AD-2 chain head like file.rename.
      const p = event.payload as EventPayloads['file.video.set']
      if (!event.fileId) {
        throw new Error(`file.video.set event ${event.id} is missing fileId`)
      }
      stmts.push(buildFileVideoSetStmt(db, event.projectId, event.fileId, event.id, p.coreMediaUrl))
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
 * Shared meta-merge for the file's core video URL (timeline preview). Used by
 * both the live handler (handlers/file-video-set.ts) and the rebuild projection
 * case above, so the SQL stays identical. `meta` is TEXT holding JSON; we cast
 * to jsonb to merge/remove the key, then back to text. Null clears the key.
 * Advances the file's AD-2 chain head (`event_id`) like file.rename.
 */
export function buildFileVideoSetStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  eventId: string,
  coreMediaUrl: string | null,
): AquillaStatement {
  const NOW = "(extract(epoch from now()) * 1000)::bigint"
  if (coreMediaUrl == null) {
    return db
      .prepare(
        `UPDATE files
            SET meta = (COALESCE(NULLIF(meta, ''), '{}')::jsonb - 'coreMediaUrl')::text,
                event_id = ?, updated_at = ${NOW}
          WHERE id = ? AND project_id = ?`,
      )
      .bind(eventId, fileId, projectId)
  }
  return db
    .prepare(
      `UPDATE files
          SET meta = (COALESCE(NULLIF(meta, ''), '{}')::jsonb || jsonb_build_object('coreMediaUrl', ?::text))::text,
              event_id = ?, updated_at = ${NOW}
        WHERE id = ? AND project_id = ?`,
    )
    .bind(coreMediaUrl, eventId, fileId, projectId)
}

/**
 * Set of event kinds that compete for the cell's chain head (advance
 * `cells.event_id`). Validation and file-level events don't move the
 * chain pointer, so they're excluded from the AD-2 guard.
 */
export const CHAIN_MUTATING_KINDS = new Set<string>([
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
 * THE single chain-mutating predicate (audit ARCH-4). route.ts previously
 * kept a parallel 17-kind deny-list; for every kind in the EventKind union
 * the two classifications were verified identical (8 chain-mutating kinds +
 * 17 excluded = the full 25-kind union), so collapsing to this allow-list
 * preserves current behavior exactly. A future kind is non-chain-mutating
 * unless added here — it projects unconditionally instead of being silently
 * dropped as a "stale sibling" (the deny-list's default-unsafe failure mode).
 */
export function isChainMutatingKind(kind: string): boolean {
  return CHAIN_MUTATING_KINDS.has(kind)
}

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
  db: AquillaDb,
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
