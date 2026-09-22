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
import { eventQualifiedParentKey } from './chain-claims'
import { ROLE } from './role-policy'
import { trackPatchRequiresExisting } from './track-editing-authority'
import { usableCorpusMarker } from './corpus-marker'
import { commentAuthorLabel } from './comment-authorship'

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

/** Set-based projection for bilingual genesis imports. These events are
 * created alongside their source parents by POST /import, so no pre-existing
 * target branch can exist. The event log still retains the parent/source pin;
 * this helper only avoids thousands of one-row projection statements. */
export function buildBulkTargetCellCommitStmt(
  db: AquillaDb,
  events: PersistedEvent<'target.cell.commit'>[],
): AquillaStatement {
  if (events.length === 0) throw new Error('buildBulkTargetCellCommitStmt: empty events')
  const byCellLane = new Map<string, PersistedEvent<'target.cell.commit'>>()
  for (const event of events) {
    if (!event.fileId || !event.cellId) {
      throw new Error(`target.cell.commit event ${event.id} is missing fileId or cellId`)
    }
    const payload = event.payload as EventPayloads['target.cell.commit']
    byCellLane.set(`${event.cellId}\u0000${laneOfEvent(event.kind, payload)}`, event)
  }

  const rows = [...byCellLane.values()]
  const binds: unknown[] = []
  for (const event of rows) {
    const payload = event.payload as EventPayloads['target.cell.commit']
    const value = payload.value ?? ''
    binds.push(
      event.projectId,
      event.fileId,
      event.cellId,
      laneOfEvent(event.kind, payload),
      value,
      payload.valueHtml ?? null,
      event.id,
      payload.sourceEventId ?? null,
      event.author,
      event.serverTs,
      countWords(value),
      contentHash(value),
      payload.ai_suggestion ? 1 : 0,
    )
  }
  const placeholders = Array(rows.length)
    .fill("(?, ?, ?, 'target', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 0, ?, ?, ?)")
    .join(',\n')
  return db.prepare(
    `INSERT INTO cells (
      project_id, file_id, cell_id, side, target_lang, value, value_html, type,
      canonical_ref, anchor_cell_id, event_id, source_event_id,
      last_editor, last_edit_at, validated, word_count, content_hash, ai_drafted
    ) VALUES ${placeholders}
    ON CONFLICT(project_id, file_id, cell_id, side, target_lang) DO UPDATE SET
      value = excluded.value,
      value_html = excluded.value_html,
      event_id = excluded.event_id,
      source_event_id = excluded.source_event_id,
      last_editor = excluded.last_editor,
      last_edit_at = excluded.last_edit_at,
      word_count = excluded.word_count,
      content_hash = excluded.content_hash,
      validated = 0,
      endorsement_count = 0,
      ai_drafted = excluded.ai_drafted`,
  ).bind(...binds)
}

/**
 * AQU-538: the target-language lane a target-side cell event addresses.
 * '' for the default lane (absent/empty `targetLang` — every pre-lane
 * event), and always '' for non-target kinds (source rows are shared by
 * all lanes and never carry a lane). Part of the cells row key and, for
 * non-default lanes, of the AD-2 chain slot (chain-claims.ts
 * laneQualifiedParentKey).
 */
export function laneOfEvent(kind: string, payload: unknown): string {
  if (!kind.startsWith('target.cell.')) return ''
  const lang = (payload as { targetLang?: unknown } | null | undefined)?.targetLang
  return typeof lang === 'string' ? lang : ''
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
 * AQU-1083 adds the structural_* trio: the same cell/filled/approved counts
 * restricted to cells whose SOURCE row is a heading or paratext. Membership is
 * a property of the source row, but filled and approved count TARGET rows whose
 * own type is null, so every row resolves its type through the paired source
 * via idx_cells_pair_lookup. They are maintained unconditionally — no counter
 * here knows anything about the setting — so a reader that excludes structural
 * cells subtracts, and the policy can be toggled without reprojecting.
 *
 * Driven FROM `files` rather than from `cells` so a file whose cells have all
 * been deleted is still reset to zero. The per-project form relied on that.
 *
 * cell_count deliberately avoids COUNT(DISTINCT cell_id): that sorts the whole
 * row set (value included, ~170 B/row) and spilled to disk on every
 * 30K+-cell file under prod's 4 MB work_mem (4.6 GB temp over 8.6 days).
 * GROUP BY cell_id over cells_pkey (project_id, file_id, cell_id, …) is an
 * ordered Index Only Scan + Group — no sort at any work_mem. Guarded by
 * __tests__/hot-query-plans.test.ts. The structural cell count needs no
 * DISTINCT at all: a cell has exactly one source row, so counting structural
 * SOURCE rows is the distinct count.
 *
 * NOTE: this is what was always meant by file-create's "counters are
 * maintained by the cell commit projection path" comment — that maintenance
 * never actually existed before, so every `files` row sat at cell_count=0.
 */
function fileCountersSql(scope: 'file' | 'project'): string {
  return `WITH counters AS (
         SELECT f.id AS file_id,
                (SELECT COUNT(*) FROM (
                   SELECT 1 FROM cells
                    WHERE project_id = f.project_id AND file_id = f.id
                    GROUP BY cell_id
                 ) AS distinct_cells)::integer AS cell_count,
                COUNT(*) FILTER (WHERE c.validated = 1)::integer AS approved_count,
                COUNT(*) FILTER (
                  WHERE c.side = 'target' AND TRIM(c.value) != ''
                )::integer AS filled_count,
                COALESCE(SUM(c.word_count) FILTER (WHERE c.side = 'target'), 0)::integer AS word_count,
                MAX(c.last_edit_at) AS last_edit_at,
                COUNT(*) FILTER (
                  WHERE c.side = 'target' AND c.ai_drafted = 1
                )::integer AS ai_drafted_count,
                COUNT(*) FILTER (
                  WHERE c.side = 'source' AND c.type IN ('heading', 'paratext')
                )::integer AS structural_cell_count,
                COUNT(*) FILTER (
                  WHERE s.type IN ('heading', 'paratext')
                    AND c.side = 'target' AND TRIM(c.value) != ''
                )::integer AS structural_filled_count,
                COUNT(*) FILTER (
                  WHERE s.type IN ('heading', 'paratext') AND c.validated = 1
                )::integer AS structural_approved_count,
                COUNT(*) FILTER (
                  WHERE s.type IN ('heading', 'paratext')
                    AND c.side = 'target' AND c.ai_drafted = 1
                )::integer AS structural_ai_drafted_count
           FROM files f
           LEFT JOIN cells c
             ON c.project_id = f.project_id
            AND c.file_id = f.id
           LEFT JOIN cells s
             ON s.project_id = c.project_id
            AND s.file_id = c.file_id
            AND s.cell_id = c.cell_id
            AND s.side = 'source'
          WHERE f.project_id = ?${scope === 'file' ? ' AND f.id = ?' : ''}
          GROUP BY f.id
       )
       UPDATE files SET cell_count = counters.cell_count,
         approved_count = counters.approved_count,
         filled_count = counters.filled_count,
         word_count = counters.word_count,
         last_edit_at = counters.last_edit_at,
         ai_drafted_count = counters.ai_drafted_count,
         structural_cell_count = counters.structural_cell_count,
         structural_filled_count = counters.structural_filled_count,
         structural_approved_count = counters.structural_approved_count,
         structural_ai_drafted_count = counters.structural_ai_drafted_count,
         updated_at = ?
        FROM counters
       WHERE files.id = counters.file_id AND files.project_id = ?`
}

export function fileCountersRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  serverTs: number,
): AquillaStatement {
  return db.prepare(fileCountersSql('file')).bind(projectId, fileId, serverTs, projectId)
}

/**
 * AQU-490: re-derive one take's vote count from `cell_audio_validators`.
 *
 * A COUNT rather than an increment, so replaying the log twice cannot drift it
 * — the same property that makes `cells.endorsement_count` safe where a stamped
 * `cells.validated` is not. Every writer of a validator row runs this
 * afterwards, which is now exactly two: validate and unvalidate. Trim used to
 * be the third and no longer touches votes at all.
 */
export function audioValidatorCountRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
  audioId: string,
): AquillaStatement {
  return db
    .prepare(
      `UPDATE cell_audio
          SET validator_count = (
            SELECT COUNT(*) FROM cell_audio_validators v
             WHERE v.project_id = cell_audio.project_id
               AND v.file_id    = cell_audio.file_id
               AND v.cell_id    = cell_audio.cell_id
               AND v.audio_id   = cell_audio.audio_id
          )
        WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?`,
    )
    .bind(projectId, fileId, cellId, audioId)
}

/**
 * The same counters for every file in a project, in one statement.
 *
 * Used by the rebuild and by POST /migrate/finalize, which both replay a whole
 * project and defer per-event counter maintenance. Both used to carry their own
 * hand-written copy of the SQL above — and one of them had already drifted,
 * silently leaving `ai_drafted_count` behind. AQU-1083 would have made that
 * worse in a way nobody would notice: a rebuild would have quietly restored
 * headings to the totals a project had chosen to exclude. One builder, two
 * scopes.
 */
export function projectFileCountersRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  serverTs: number,
): AquillaStatement {
  return db.prepare(fileCountersSql('project')).bind(projectId, serverTs, projectId)
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
  // AQU-538: bulk import is source-only; source rows always live on the
  // default lane (target_lang = '', a literal — no bind).
  const placeholders = Array(rows.length)
    .fill("(?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?::text::jsonb)")
    .join(',\n')
  return db
    .prepare(
      `INSERT INTO cells (
        project_id, file_id, cell_id, side, target_lang, value, value_html, type,
        canonical_ref, anchor_cell_id, event_id, source_event_id,
        last_editor, last_edit_at, validated, word_count, content_hash,
        start_ms, end_ms,
        medium, sequence_index, transcription, camera_state, metadata
      ) VALUES ${placeholders}
      ON CONFLICT(project_id, file_id, cell_id, side, target_lang) DO UPDATE SET
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
export type ProjectionTouches = 'cells' | 'cell_validators' | 'cell_waivers' | 'files' | 'cell_audio' | 'cell_audio_validators' | 'comments' | 'cell_backtranslations' | 'cell_links' | 'cell_word_morph' | 'concepts'

/**
 * Apply one event to the projection (without the AD-2 sibling guard — the
 * caller is responsible for that). Adds D1PreparedStatements to `stmts`
 * so the caller can batch many events into one db.batch() call.
 *
 * The returned `touches` list lets the route layer compute the
 * `projection.dirty` broadcast payload.
 */
/**
 * AQU-927: payload keys that are projected into a Postgres **BIGINT** column
 * (`cells.start_ms/end_ms`, `cell_audio.duration_ms/trim_start_ms/trim_end_ms`)
 * or into a ms-valued metadata key compared against them.
 */
const INTEGER_MS_PAYLOAD_KEYS = [
  'durationMs',
  'startMs',
  'endMs',
  'trimStartMs',
  'trimEndMs',
  'subtitleStartMs',
  'subtitleEndMs',
  'targetStartMs',
] as const

/**
 * AQU-927: round fractional millisecond payload values before they are bound
 * into a BIGINT column.
 *
 * Postgres rejects a fractional bigint literal, and a `/events` flush is
 * applied as ONE batch — so a single stray float (e.g. a duration of `2403.5`
 * from an un-rounded client producer) failed *every* event in that flush, which
 * is how whole groups of cells silently lost their audio on refresh. Clients
 * now round at the source and again at the emit boundary; this is the server's
 * last line of defence, and it also covers clients already deployed with the
 * old code.
 *
 * Returns the event unchanged (same object identity) when nothing needed
 * rounding, which is the overwhelmingly common case. Non-finite values are left
 * alone so the existing `Number.isFinite` guards still reject them.
 */
export function coerceIntegerMsPayload(event: PersistedEvent): PersistedEvent {
  const payload = event.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return event
  let fixed: Record<string, unknown> | null = null
  for (const key of INTEGER_MS_PAYLOAD_KEYS) {
    const value = (payload as Record<string, unknown>)[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || Number.isInteger(value)) continue
    fixed ??= { ...(payload as Record<string, unknown>) }
    fixed[key] = Math.round(value)
  }
  return fixed === null ? event : { ...event, payload: fixed }
}

export function buildEventProjectionStmts(
  db: AquillaDb,
  rawEvent: PersistedEvent,
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
     * AQU-279: project-level threshold for cells.validated.
     * `cells.validated` flips to 1 when the cell has at least this many
     * current-head validators. Default 1 (N=1 projects: byte-identical behavior).
     */
    validationCount?: number
  },
): ProjectionTouches[] {
  // AQU-927: one un-rounded ms value would otherwise reject the whole batch.
  const event = coerceIntegerMsPayload(rawEvent)
  // Gate fragments for chain-advancing cells writes. `gateWhere` suffixes an
  // INSERT…SELECT row source; `gateAnd` extends an UPDATE/DELETE WHERE;
  // `gateConflictWhere` suffixes an UPSERT's ON CONFLICT DO UPDATE.
  //
  // AQU-1154 (invariant I1): besides holding the chain claim, the write is a
  // compare-and-swap on the cell's CURRENT head — an existing row is only
  // advanced when `cells.event_id` still equals this event's parentId. The
  // claim alone is first-child-of-parent, which let a stale branch climb back
  // onto the head (B1 loses to A1, then B2 chained on B1 found the (cell, B1)
  // slot free and overwrote A1). A row that does not exist yet has no head to
  // compare, so the INSERT path is claim-gated only (a cell's first target
  // commit legitimately chains on the SOURCE head). The route reads each
  // gated statement's row count back: 0 rows == lost the CAS == stale.
  const gate = opts?.chainGate
  const GATE_EXISTS =
    'EXISTS (SELECT 1 FROM chain_claims WHERE project_id = ? AND file_id = ? AND cell_id = ? AND parent_key = ? AND event_id = ?)'
  const HEAD_CAS = 'cells.event_id = ?'
  const gateWhere = gate ? ` WHERE ${GATE_EXISTS}` : ''
  const gateConflictWhere = gate ? ` WHERE ${HEAD_CAS}` : ''
  const gateAnd = gate ? ` AND ${GATE_EXISTS} AND ${HEAD_CAS}` : ''
  const gateBinds: unknown[] = gate
    ? [gate.projectId, gate.fileId, gate.cellId, gate.parentKey, event.id, event.parentId]
    : []

  // The same gate, for a statement that is NOT against `cells`.
  //
  // `HEAD_CAS` names a `cells` column, so it is only legal in a statement whose
  // own target is that table. AQU-1068's dependent cleanup (validators, takes,
  // pairings, comments, waivers, back-translations, morph rows) is not, and
  // pasting `gateAnd` onto it produced `missing FROM-clause entry for table
  // "cells"` — a hard Postgres error that failed the whole transaction, so a
  // parented `source.cell.delete` 500'd and the removal was lost. Every in-app
  // removal sends a parent, so this broke the feature outright; it survived
  // 1,700 green tests because every cascade test builds a parent-less event,
  // where `gate` is undefined and both fragments are empty strings.
  //
  // The head check is preserved as a SUBQUERY instead: same predicate, legal
  // anywhere. It has to be, or a delete that lost the CAS would still strip a
  // surviving cell of everything hanging off it. That is why these statements
  // are emitted BEFORE the `cells` DELETE — they run in batch order, so the row
  // whose head they are testing is still there when they ask.
  const HEAD_EXISTS =
    'EXISTS (SELECT 1 FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ? AND target_lang = ? AND event_id = ?)'
  const dependentGateAnd = gate ? ` AND ${GATE_EXISTS} AND ${HEAD_EXISTS}` : ''
  /** Binds for `dependentGateAnd`. The side and lane are the caller's, so the
   *  subquery tests the SAME row the accompanying `cells` write does. */
  const dependentGateBindsFor = (side: string, lane: string): unknown[] =>
    gate
      ? [
          gate.projectId, gate.fileId, gate.cellId, gate.parentKey, event.id,
          gate.projectId, gate.fileId, gate.cellId, side, lane, event.parentId,
        ]
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

      // AQU-538: the lane is part of the row key. '' for source creates and
      // default-lane target creates; a non-'' target lane creates that lane's
      // own row beside its siblings.
      const lane = laneOfEvent(event.kind, p)
      stmts.push(
        db
          .prepare(
            `INSERT INTO cells (
              project_id, file_id, cell_id, side, target_lang, value, value_html, type,
              canonical_ref, anchor_cell_id, event_id, source_event_id,
              last_editor, last_edit_at, validated, word_count, content_hash,
              start_ms, end_ms,
              medium, sequence_index, transcription, camera_state, metadata
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?::text::jsonb${gateWhere}
            ON CONFLICT(project_id, file_id, cell_id, side, target_lang) DO UPDATE SET
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
              metadata       = excluded.metadata${gateConflictWhere}`,
          )
          .bind(
            event.projectId,
            event.fileId,
            cellId,
            side,
            lane,
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

    case 'source.cell.metadata.patch': {
      const p = event.payload as EventPayloads['source.cell.metadata.patch']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      if (event.schemaVersion !== 2 || p.version !== 1) {
        throw new Error(
          `${event.kind} event ${event.id} requires event schemaVersion 2 and payload version 1`,
        )
      }
      if (!p.metadata || typeof p.metadata !== 'object' || Array.isArray(p.metadata)) {
        throw new Error(`${event.kind} event ${event.id} has invalid metadata`)
      }
      const metadataJson = JSON.stringify(p.metadata)
      stmts.push(
        db
          .prepare(
            `UPDATE cells SET
               metadata = (COALESCE(metadata, '{}'::jsonb) || ?::text::jsonb),
               value_html = CASE WHEN ?::text IS NULL THEN value_html ELSE ?::text END
             WHERE project_id = ? AND file_id = ? AND cell_id = ?
               AND side = 'source' AND target_lang = ''`,
          )
          .bind(
            metadataJson,
            p.valueHtml ?? null,
            p.valueHtml ?? null,
            event.projectId,
            event.fileId,
            event.cellId,
          ),
      )
      if (p.targetHtml !== undefined) {
        stmts.push(
          db
            .prepare(
              `UPDATE cells SET value_html = ?
               WHERE project_id = ? AND file_id = ? AND cell_id = ?
                 AND side = 'target' AND target_lang = ''`,
            )
            .bind(p.targetHtml, event.projectId, event.fileId, event.cellId),
        )
      }
      return ['cells']
    }

    case 'source.cell.reanchor': {
      const p = event.payload as EventPayloads['source.cell.reanchor']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      // Anchor-ONLY repair (AQU-931): re-point the source row's anchor without
      // advancing the chain head. `event_id` moves only when content changes —
      // the AD-9 staleness comparison (target pin vs source head) depends on
      // that — and validation, counters, and FTS are untouched. Non-chain-
      // mutating by design: rebuild replays it unconditionally in seq order
      // (a chain-mutating event with a null parent would lose first-child
      // arbitration to the genesis create and the repair would evaporate on
      // every rebuild).
      stmts.push(
        db
          .prepare(
            `UPDATE cells SET anchor_cell_id = ?
             WHERE project_id = ? AND file_id = ? AND cell_id = ?
               AND side = 'source' AND target_lang = ''`,
          )
          .bind(p.anchorCellId ?? null, event.projectId, event.fileId, event.cellId),
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

      // FTS5 maintenance (pre-DML): remove the OLD indexed value before we
      // overwrite the cells row. Must run first so the old value is still
      // readable from `cells`.

      if (event.kind === 'target.cell.commit') {
        const tp = p as EventPayloads['target.cell.commit']
        const sourceEventId = tp.sourceEventId ?? null
        // AQU-292: set ai_drafted=1 when the commit carries ai_suggestion, clear to 0
        // on any human commit (ai_suggestion absent). Human edit reclassifies the cell.
        const aiDrafted = tp.ai_suggestion ? 1 : 0
        // AQU-538: the lane this commit addresses ('' = default lane). Part of
        // the row key — each lane's first commit INSERTs that lane's row.
        const lane = laneOfEvent(event.kind, tp)

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
                project_id, file_id, cell_id, side, target_lang, value, value_html, type,
                canonical_ref, anchor_cell_id, event_id, source_event_id,
                last_editor, last_edit_at, validated, word_count, content_hash,
                ai_drafted, ai_draft
              ) SELECT ?, ?, ?, 'target', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?${gateWhere}
              ON CONFLICT(project_id, file_id, cell_id, side, target_lang) DO UPDATE SET
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
                ai_drafted        = excluded.ai_drafted,
                ai_draft          = excluded.ai_draft${gateConflictWhere}`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              lane,
              value,
              valueHtml,
              event.id,
              sourceEventId,
              event.author,
              event.serverTs,
              wordCount,
              hash,
              aiDrafted,
              aiDrafted ? JSON.stringify(tp.ai_draft ?? null) : null,
              ...gateBinds,
            ),
        )

        // AQU-826: the winning human target commit is the durable review
        // boundary for Autopilot drafts. Accepted cards intentionally do not
        // call the review route: an IDB enqueue is not proof that this event
        // won projection. Resolve every still-live proposal for this exact
        // project/file/cell/lane in the same transaction as the cell write.
        //
        // `cells.event_id = event.id` is deliberately the final authority:
        // an AD-2 sibling that lost `chainGate` did not advance the cell, so it
        // must not resolve a proposal either. `draft.created_at <= serverTs`
        // is the rebuild causality boundary: replaying a historical commit may
        // rebuild the cell head, but it can never review a proposal staged
        // later. Drafts carry their own `target_lang` (copied from the owning
        // run at insert) so a French commit cannot apply a Spanish proposal.
        // Text equality is exact; normalizing whitespace here would claim a
        // proposal was applied when the committed artifact differs byte-for-
        // byte. The partial live-draft index permits at most one reconciled row
        // for this cell+lane, so its activity fact reuses the winning commit's
        // UUIDv7: stable on replay, with no invented ID shape. A malformed
        // legacy envelope skips only the evidence INSERT via the UUIDv7
        // predicate; it must never roll back the cell/draft projection.
        stmts.push(
          db
            .prepare(
              `WITH reconciled AS (
                 UPDATE contextual_drafts AS draft
                    SET status = CASE WHEN draft.text = ? THEN 'applied' ELSE 'superseded' END,
                        reviewed_at = to_timestamp(?::double precision / 1000.0),
                        reviewed_by = ?
                  WHERE draft.project_id = ?
                    AND draft.file_id = ?
                    AND draft.cell_id = ?
                    AND draft.created_at <= to_timestamp(?::double precision / 1000.0)
                    AND draft.status = 'proposed'
                    AND draft.target_lang = ?
                    AND EXISTS (
                      SELECT 1
                        FROM cells AS projected
                       WHERE projected.project_id = ?
                         AND projected.file_id = ?
                         AND projected.cell_id = ?
                         AND projected.side = 'target'
                         AND projected.target_lang = ?
                         AND projected.event_id = ?
                    )
                 RETURNING draft.id, draft.run_id, draft.project_id,
                           draft.file_id, draft.cell_id, draft.status
               )
               INSERT INTO contextual_run_events
                 (id, run_id, project_id, file_id, kind, span_id, span_label,
                  status, phase, summary, details, created_at)
               SELECT ?, run_id, project_id, file_id, 'draft_reviewed', NULL, NULL,
                      status,
                      NULL,
                      CASE WHEN status = 'applied' THEN 'Draft applied' ELSE 'Draft superseded' END,
                      jsonb_build_object(
                        'draftId', left(id, 256),
                        'cellId', left(cell_id, 256),
                        'outcome', status
                      ),
                      to_timestamp(?::double precision / 1000.0)
                 FROM reconciled
                WHERE octet_length(run_id) <= 512
                  AND octet_length(project_id) <= 512
                  AND octet_length(file_id) <= 512
                  AND ? ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$'
               ON CONFLICT (id) DO NOTHING`,
            )
            .bind(
              value,
              event.serverTs,
              event.author,
              event.projectId,
              event.fileId,
              event.cellId,
              event.serverTs,
              lane,
              event.projectId,
              event.fileId,
              event.cellId,
              lane,
              event.id,
              event.id,
              event.serverTs,
              event.id,
            ),
        )
      } else {
        // source.cell.commit — same as target but no source_event_id pin
        // (it's null on source-side rows by definition). Source-side
        // validations aren't a v1 concept, so `validated` is left alone
        // here — for source-side rows it stays at its initial 0 forever.
        // A TRANSCRIPT-ONLY COMMIT MUST NOT BLANK THE FILENAME. The editor
        // resends `value` unchanged on a media correction, so normally this
        // writes the filename back over itself — but a payload carrying only
        // `transcription` (an older client, or any other caller) would
        // otherwise land `value = ''` through the `?? ''` above and destroy
        // the import record the correction was written to protect. The chain
        // head still advances either way, which is what flags downstream
        // targets stale (AD-9): the text translators work from has changed.
        const spCommit = p as EventPayloads['source.cell.commit']
        const transcriptOnly = p.value === undefined && typeof spCommit.transcription === 'string'
        stmts.push(
          db
            .prepare(
              transcriptOnly
                ? `UPDATE cells SET
                    event_id      = ?,
                    last_editor   = ?,
                    last_edit_at  = ?
                  WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'${gateAnd}`
                : `UPDATE cells SET
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
              ...(transcriptOnly
                ? [event.id, event.author, event.serverTs]
                : [value, valueHtml, event.id, event.author, event.serverTs, wordCount, hash]),
              event.projectId,
              event.fileId,
              event.cellId,
              ...gateBinds,
            ),
        )

        // AQU-847: a source edit on an imported MEDIA section corrects its
        // TRANSCRIPT, not its `value` — `value` holds the import filename and
        // stays put as provenance. Conditional (only when supplied) so every
        // ordinary text-cell source commit projects exactly as before, and
        // scoped to side='source' like the `cell.audio.attach` transcript
        // write it mirrors. Without this the correction was accepted, chained,
        // and then silently discarded.
        const sp = p as EventPayloads['source.cell.commit']
        if (typeof sp.transcription === 'string') {
          stmts.push(
            db
              .prepare(
                `UPDATE cells SET transcription = ?
                  WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
              )
              .bind(sp.transcription, event.projectId, event.fileId, event.cellId),
          )
        }
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
      // AQU-538: and only the LANE this event targets — a target delete on
      // lane 'fr' leaves the default lane and every sibling lane intact.
      // Source deletes bind lane '' (source rows always live on '').
      const side = event.kind === 'target.cell.delete' ? 'target' : 'source'
      const lane = laneOfEvent(event.kind, event.payload)
      const dependentGateBinds = dependentGateBindsFor(side, lane)

      // FTS5 maintenance (pre-DML): remove the indexed value BEFORE deleting
      // the cells row so the OLD value is still readable for the 'delete'
      // command.

      // AQU-1068: TAKE THE CELL'S DEPENDENTS WITH IT.
      //
      // Nothing in the schema references `cells`, so nothing cascades — and
      // until this feature only an EMPTY line a person had added by hand could
      // be removed, which is precisely why that restriction existed. Removing
      // an imported cell is the new capability, and an imported cell is exactly
      // the one likely to carry validations, takes, pairings and comments.
      // Left behind, every one of them points at a row that no longer exists.
      //
      // THIS BELONGS IN THE PROJECTION, not in the route. Projection tables are
      // rebuilt by replaying the event log (rebuild.ts), and a rebuild wipes
      // only `cells`, `cell_validators` and `file_section_progress` — so
      // cleanup done anywhere else would simply never be re-applied, and the
      // orphans would come back the first time somebody rebuilt. Replaying
      // these is safe: deleting what is already gone is a no-op.
      //
      // Gated exactly as the `cells` DELETE below is — a delete that LOST its
      // chain slot must not strip the surviving cell of its dependents — but
      // through `dependentGateAnd`, which expresses the head check as a
      // subquery because these statements do not target `cells` (see the
      // fragment's own note). They are emitted BEFORE that DELETE so the row
      // they are testing still exists when they run.
      const dependentBinds = [event.projectId, event.fileId, event.cellId]
      if (event.kind === 'source.cell.delete') {
        // THE TRANSLATIONS GO WITH THE SOURCE, in every lane.
        //
        // The client used to batch one `target.cell.delete` per lane beside
        // this event, and that was wrong twice over.
        //
        // Correctness: those deletes are parent-less tombstones, so they apply
        // unconditionally — while THIS event still has to win its chain slot.
        // A source delete that went stale therefore left the cell in place and
        // took its translations anyway.
        //
        // Permissions: `target.cell.delete` floors at CONTRIBUTOR and is not
        // governed by `cellEditingFloor`, so once the tier list grew Commenter
        // and Reviewer rungs (AQU-1068 review), a person the project had
        // explicitly admitted could add a cell and then not remove one —
        // `enqueueEvents` threw before writing anything, so the row left the
        // screen with no request sent and no rollback. Making the removal a
        // source-side act throughout puts the whole cascade under the one
        // gate that is supposed to govern it.
        //
        // Bound by cell only: every lane's row goes, which is what deleting
        // the cell means. A single lane is still removed on its own by its own
        // `target.cell.delete`, and that path is untouched.
        stmts.push(
          db
            .prepare(
              `DELETE FROM cells
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'${dependentGateAnd}`,
            )
            .bind(...dependentBinds, ...dependentGateBinds),
        )
        // The whole cell is going, so every lane's validators go with it —
        // they are keyed on the cell and would outlive the rows above.
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_validators
               WHERE project_id = ? AND file_id = ? AND cell_id = ?${dependentGateAnd}`,
            )
            .bind(...dependentBinds, ...dependentGateBinds),
        )
        // Takes: SOFT-deleted, the same shape `cell.audio.remove` uses (a
        // `deleted` flag, not a DELETE). The R2 bytes outlive the row either
        // way — an orphan sweep is separate work — and keeping the row keeps
        // the object key discoverable for it.
        stmts.push(
          db
            .prepare(
              `UPDATE cell_audio SET deleted = 1, selected = 0
               WHERE project_id = ? AND file_id = ? AND cell_id = ?${dependentGateAnd}`,
            )
            .bind(...dependentBinds, ...dependentGateBinds),
        )
        // Pairings: TOMBSTONED (`linked = 0`), not deleted, because that is
        // what unlinking means here — the schema comment on cell_links spells
        // out why a hard delete would let a replayed import-time linker
        // resurrect an edge. The cell can sit at either end of the pair.
        stmts.push(
          db
            .prepare(
              `UPDATE cell_links SET linked = 0
               WHERE project_id = ?
                 AND ((from_file_id = ? AND from_cell_id = ?)
                   OR (to_file_id = ? AND to_cell_id = ?))${dependentGateAnd}`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              event.fileId,
              event.cellId,
              ...dependentGateBinds,
            ),
        )
        // Comments: soft-deleted exactly as `comment.delete` does it, so a
        // thread on a removed cell reads as deleted rather than as a thread
        // pointing nowhere. Replies carry the same cell scope as their root.
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = '', deleted_at = ?, updated_at = ?
               WHERE project_id = ? AND file_id = ? AND cell_id = ?
                 AND scope_kind = 'cell' AND deleted_at IS NULL${dependentGateAnd}`,
            )
            .bind(event.serverTs, event.serverTs, ...dependentBinds, ...dependentGateBinds),
        )
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_waivers
               WHERE project_id = ? AND file_id = ? AND cell_id = ?${dependentGateAnd}`,
            )
            .bind(...dependentBinds, ...dependentGateBinds),
        )
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_backtranslations
               WHERE project_id = ? AND file_id = ? AND cell_id = ?${dependentGateAnd}`,
            )
            .bind(...dependentBinds, ...dependentGateBinds),
        )
        // Morph analysis is written by the /import-morph route, never by an
        // event — so this DELETE is its only cleanup path anywhere. Harmless
        // on replay for the same reason as the rest.
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_word_morph
               WHERE project_id = ? AND file_id = ? AND cell_id = ?${dependentGateAnd}`,
            )
            .bind(...dependentBinds, ...dependentGateBinds),
        )
      } else {
        // A target delete removes ONE lane. Only that lane's validators go;
        // the cell and every sibling lane stay exactly as they were.
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_validators
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND target_lang = ?${dependentGateAnd}`,
            )
            .bind(...dependentBinds, lane, ...dependentGateBinds),
        )
      }

      // LAST, deliberately: every statement above tests this row's head with
      // `HEAD_EXISTS`, and they run in batch order.
      stmts.push(
        db
          .prepare(
            `DELETE FROM cells
             WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ? AND target_lang = ?${gateAnd}`,
          )
          .bind(event.projectId, event.fileId, event.cellId, side, lane, ...gateBinds),
      )

      if (!opts?.deferFileCounters)
        stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
      return event.kind === 'source.cell.delete'
        ? [
            'cells',
            'files',
            'cell_validators',
            'cell_audio',
            'cell_links',
            'comments',
            'cell_waivers',
            'cell_backtranslations',
            'cell_word_morph',
          ]
        : ['cells', 'files', 'cell_validators']
    }

    case 'source.cell.reorder':
    case 'target.cell.reorder': {
      const p = event.payload as EventPayloads['source.cell.reorder'] | EventPayloads['target.cell.reorder']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      const side = event.kind === 'target.cell.reorder' ? 'target' : 'source'
      // AQU-538: reorder advances one lane's chain head; source reorders bind
      // lane '' (source rows always live on '').
      const lane = laneOfEvent(event.kind, p)
      stmts.push(
        db
          .prepare(
            `UPDATE cells SET
              anchor_cell_id = ?,
              event_id       = ?,
              last_editor    = ?,
              last_edit_at   = ?
            WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = ? AND target_lang = ?${gateAnd}`,
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
            lane,
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

      // AQU-538: the lane this validation addresses. Absent/'' = default lane
      // (byte-identical for N=1). A user's standing validation is per-lane —
      // the cell_validators PK carries target_lang — so validating a cell in
      // lane A leaves lane B's validators (and validated flag) untouched.
      const lane =
        typeof (p as { targetLang?: unknown }).targetLang === 'string'
          ? (p as { targetLang?: string }).targetLang!
          : ''

      // DELETE-on-unvalidate (spec §"Validator record"): a row exists iff
      // the validator currently endorses the cell. `cell.validate` upserts
      // one row per (cell, lane, validator) carrying the validated commit's
      // `event_id`; `cell.unvalidate` deletes it. The decided_ts guard keeps
      // out-of-order replays from clobbering a newer decision.
      if (event.kind === 'cell.validate') {
        stmts.push(
          db
            .prepare(
              `INSERT INTO cell_validators (
                project_id, file_id, cell_id, target_lang, event_id, username, decided_ts
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(project_id, file_id, cell_id, target_lang, username)
              DO UPDATE SET
                event_id   = excluded.event_id,
                decided_ts = excluded.decided_ts
              WHERE excluded.decided_ts > cell_validators.decided_ts`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              lane,
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
                WHERE project_id = ? AND file_id = ? AND cell_id = ?
                  AND target_lang = ? AND username = ?`,
            )
            .bind(event.projectId, event.fileId, event.cellId, lane, targetUsername),
        )
      }

      // AQU-292: validation supersedes AI-drafted status. Once a reviewer
      // validates a cell, it moves to "Validated" — the "AI-drafted awaiting
      // review" label no longer applies regardless of the commit provenance.
      // Clear ai_drafted = 0 on cell.validate so the file counter reflects
      // that the cell is no longer in the "awaiting review" bucket.
      if (event.kind === 'cell.validate') {
        stmts.push(
          db
            .prepare(
              `UPDATE cells SET ai_drafted = 0, ai_draft = NULL
               WHERE project_id = ? AND file_id = ? AND cell_id = ?
                 AND side = 'target' AND target_lang = ?`,
            )
            .bind(event.projectId, event.fileId, event.cellId, lane),
        )
      }

      // Recompute the denormalized `cells.validated` flag against the
      // CURRENT chain head (`cells.event_id`). A cell is "validated" when
      // the number of current-head validators meets the project threshold.
      //
      // AQU-279: threshold is `opts.validationCount` (default 1). N=1
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
              WHERE project_id  = ?
                AND file_id     = ?
                AND cell_id     = ?
                AND target_lang = ?
                AND event_id    = cells.event_id
            )
            WHERE project_id = ? AND file_id = ? AND cell_id = ?
              AND side = 'target' AND target_lang = ?`,
          )
          .bind(
            validationThreshold,
            event.projectId,
            event.fileId,
            event.cellId,
            lane,
            event.projectId,
            event.fileId,
            event.cellId,
            lane,
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
              WHERE project_id  = ?
                AND file_id     = ?
                AND cell_id     = ?
                AND target_lang = ?
                AND event_id    = cells.event_id
            )
            WHERE project_id = ? AND file_id = ? AND cell_id = ?
              AND side = 'target' AND target_lang = ?`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            lane,
            event.projectId,
            event.fileId,
            event.cellId,
            lane,
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
      // SUB-49: a re-attach may only ADD to what is known about a clip. The
      // COALESCE'd columns describe the clip ITSELF, and producers routinely
      // send a partial payload — transcription re-attaches carrying only its
      // timings, a trim carrying only trims. Plain `excluded.x` read "field
      // absent" as "erase it", so finishing a transcription silently nulled a
      // recording's duration (its chip lost its length), its mime type and its
      // voice; a later trim then nulled the timings straight back. `label` was
      // the only protected column, which is why names survived and everything
      // else didn't.
      //
      // 2026-08-14: the trim columns joined them, and the exemption they used
      // to carry ("dragging an edge back to the clip boundary CLEARS them") was
      // the last instance of the same bug. Clearing and having-no-opinion were
      // both spelled "field absent", so the transcription's word-timings attach
      // — which lands ~800ms after a take is saved — wiped the window every
      // recorded take had just been given, leaving it anchored a few hundred ms
      // early with nothing to undo the shift. An attach may now SET a window
      // (a clip's birth values) and never clear one; clearing belongs to
      // cell.audio.trim, which states both ends and can therefore mean NULL.
      stmts.push(
        db
          .prepare(
            `INSERT INTO cell_audio (
              project_id, file_id, cell_id, audio_id, slot, url, mime_type,
              voice_id, reference_audio_id, duration_ms, label, trim_start_ms, trim_end_ms,
              timings_json, selected, deleted, event_id, created_ts, role, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
            ON CONFLICT(project_id, file_id, cell_id, audio_id) DO UPDATE SET
              slot               = excluded.slot,
              url                = excluded.url,
              mime_type          = COALESCE(excluded.mime_type, cell_audio.mime_type),
              voice_id           = COALESCE(excluded.voice_id, cell_audio.voice_id),
              reference_audio_id = COALESCE(excluded.reference_audio_id, cell_audio.reference_audio_id),
              duration_ms        = COALESCE(excluded.duration_ms, cell_audio.duration_ms),
              label              = COALESCE(excluded.label, cell_audio.label),
              trim_start_ms      = COALESCE(excluded.trim_start_ms, cell_audio.trim_start_ms),
              trim_end_ms        = COALESCE(excluded.trim_end_ms, cell_audio.trim_end_ms),
              timings_json       = COALESCE(excluded.timings_json, cell_audio.timings_json),
              selected           = 1,
              deleted            = 0,
              event_id           = excluded.event_id,
              -- AQU-490: created_by is FILL-ONLY, and deliberately so. A
              -- re-attach is routine — the transcription lands ~800ms after
              -- every recording, trims persist, timings refresh — and each
              -- carries the author of whoever triggered it. Assigning it here
              -- would hand a take's authorship to the last person who touched
              -- it, which on a project with self-validation off would then
              -- refuse the real recorder permission to validate their own take.
              created_by         = COALESCE(cell_audio.created_by, excluded.created_by),
              -- role is NOT NULL (pre-0096 rows defaulted to 'dub'), so it
              -- cannot be COALESCEd into place. It may only ever be PROMOTED to
              -- 'source': a re-import is authoritative and repairs a row the
              -- rollout's filename heuristic missed, while a routine re-attach
              -- — which always binds 'dub' because it says nothing about role —
              -- must never demote the shared programme audio to a dub and gate
              -- every cell of that file on somebody validating it.
              role               = CASE WHEN excluded.role = 'source' THEN 'source'
                                        ELSE cell_audio.role END`,
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
            // AQU-646 round 8: a take's permanent name. Re-attaches without a
            // label (trim persists) keep the existing one (COALESCE above).
            p.label ?? null,
            p.trimStartMs ?? null,
            p.trimEndMs ?? null,
            p.timings ? JSON.stringify(p.timings) : null,
            event.id,
            event.serverTs,
            // AQU-490: 'source' only when the attach says so — an import
            // declaring the shared programme audio. Everything else is a dub,
            // which is what the default and every historical row mean.
            p.role === 'source' ? 'source' : 'dub',
            event.author,
          ),
      )
      // AQU-646: an attach may carry the ASR transcript of a media segment.
      // Land it on the SOURCE cell row so imported audio surfaces translatable
      // source text. Conditional (only when supplied) so ordinary re-attaches
      // (timings refresh, trims) never clobber an existing transcription, and
      // scoped to side='source' so a recorded take on a target cell can never
      // overwrite source text.
      if (typeof p.transcription === 'string') {
        stmts.push(
          db
            .prepare(
              `UPDATE cells SET transcription = ?
                WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
            )
            .bind(p.transcription, event.projectId, event.fileId, event.cellId),
        )
        return ['cell_audio', 'cells']
      }
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

    case 'cell.audio.rename': {
      // AQU-646 round 8: label-only rename — deliberately NOT a re-attach
      // (which would also re-select the clip). Selection, trims, timings,
      // everything else untouched. null clears back to unnamed.
      const p = event.payload as EventPayloads['cell.audio.rename']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cell.audio.rename event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET label = ?
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?`,
          )
          .bind(p.label, event.projectId, event.fileId, event.cellId, p.audioId),
      )
      return ['cell_audio']
    }

    case 'cell.audio.trim': {
      // The clip's playback trim window, and nothing else — no selection, no
      // slot, no url, no duration. Both ends are always stated (null = the clip
      // edge), so unlike the attach UPSERT above this one CAN clear, which is
      // the whole reason it exists: absence had to stop meaning two things.
      const p = event.payload as EventPayloads['cell.audio.trim']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cell.audio.trim event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET trim_start_ms = ?, trim_end_ms = ?
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?`,
          )
          .bind(
            p.trimStartMs ?? null,
            p.trimEndMs ?? null,
            event.projectId,
            event.fileId,
            event.cellId,
            p.audioId,
          ),
      )
      // A TRIM KEEPS ITS VOTES (Sam, 2026-09-21, reversing his earlier call).
      // This used to delete the take's validator rows on the reasoning that
      // trimming changes what a validator heard. It is the same take: no new
      // audio_id is minted, the samples are untouched, and only the playback
      // window moves — usually by a fraction of a second, to clip a breath.
      // Making a reviewer re-listen to a whole line for that is not a rule
      // anyone would defend out loud. Denoise is the genuinely derived case
      // and is unaffected: it mints a `dn-` id and attaches it, so its take
      // starts unvalidated for free.
      //
      // Dropping the delete also makes this handler honest with the rollup
      // set below it. `cell.audio.trim` is deliberately absent from
      // AUDIO_ROLLUP_KINDS because trim "changes no count" — yet it has been
      // zeroing validator_count with no progress recompute behind it, so the
      // board went on reporting a trimmed line as validated. Now that is true
      // rather than merely unnoticed.
      return ['cell_audio']
    }

    case 'cell.audio.place': {
      // WHERE THIS TAKE SITS, and nothing else. (AQU-646 stage 3)
      //
      // The sibling of cell.audio.trim above, and the same discipline: one
      // column, always stated, `null` meaning "clear it". It is a separate kind
      // from the attach for the reason spelled out on the payload type —
      // absence must go on meaning exactly one thing.
      //
      // NOT SCOPED BY SLOT, on purpose. `audio_id` is unique within a cell (it
      // is part of the primary key), so naming the take is naming the row; a
      // slot term could only ever disagree with itself.
      const p = event.payload as EventPayloads['cell.audio.place']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cell.audio.place event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET target_offset_ms = ?
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?`,
          )
          .bind(
            // `?? null` and NOT `|| null`: 0 is a legal, common offset — a take
            // placed exactly at its line's start — and `||` would turn it back
            // into "never placed".
            p.targetOffsetMs ?? null,
            event.projectId,
            event.fileId,
            event.cellId,
            p.audioId,
          ),
      )
      return ['cell_audio']
    }

    case 'cell.link.set': {
      // One edge between a subtitle cell (the envelope) and an audio cue (the
      // payload). The ENDPOINTS are the primary key, so this is idempotent by
      // construction: re-delivering an event, or replaying the whole log,
      // lands on the same row rather than accumulating duplicates.
      //
      // `linked` is PLAIN-ASSIGNED, and that is correct here precisely because
      // the payload always states it — do not "fix" this to COALESCE. An
      // unlink is a tombstone (linked = 0) rather than a deleted row so that a
      // later replay of the auto-linker's own event cannot resurrect an edge a
      // person deliberately removed.
      //
      // `created_ts` is NOT overwritten: it records when the edge first
      // appeared, which survives every later toggle of the same pair.
      const p = event.payload as EventPayloads['cell.link.set']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cell.link.set event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `INSERT INTO cell_links (
              project_id, kind, from_file_id, from_cell_id, to_file_id, to_cell_id,
              linked, origin, confidence, event_id, created_ts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, kind, from_file_id, from_cell_id, to_file_id, to_cell_id)
            DO UPDATE SET
              linked     = excluded.linked,
              origin     = excluded.origin,
              confidence = excluded.confidence,
              event_id   = excluded.event_id`,
          )
          .bind(
            event.projectId,
            p.kind,
            event.fileId,
            event.cellId,
            p.toFileId,
            p.toCellId,
            p.linked ? 1 : 0,
            p.origin,
            p.confidence ?? null,
            event.id,
            event.serverTs,
          ),
      )
      return ['cell_links']
    }

    case 'cell.audio.measure': {
      // Duration backfill for takes that predate duration capture. COALESCE
      // makes it fill-only: a row that already knows its length keeps it, so
      // replays and races with a genuine re-attach are no-ops. Selection,
      // url, slot, trims, timings: untouched by design (the attach UPSERT
      // re-selects and plain-assigns trims — exactly what a backfill of an
      // arbitrary, possibly non-selected take must never do).
      const p = event.payload as EventPayloads['cell.audio.measure']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cell.audio.measure event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE cell_audio SET duration_ms = COALESCE(duration_ms, ?)
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND audio_id = ?`,
          )
          .bind(p.durationMs, event.projectId, event.fileId, event.cellId, p.audioId),
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

    case 'cell.audio.validate':
    case 'cell.audio.unvalidate': {
      // AQU-490: one vote per person per TAKE, counted against the project's
      // threshold when somebody reads — the same shape as the text-side
      // cell.validate, and for the same reason: a boolean could not say "this
      // project needs two reviewers", and a stamped boolean goes stale the
      // moment the threshold moves or the projection is rebuilt.
      //
      // The vote is keyed by audio_id, so re-recording (which attaches and
      // selects a NEW take) leaves the old take's votes intact but no longer
      // counted — every rollup reads the cell's SELECTED takes, so the cell
      // drops back to needing validation until the new one earns its own.
      const p = event.payload as EventPayloads['cell.audio.validate']
      if (!event.fileId || !event.cellId) {
        throw new Error(`${event.kind} event ${event.id} is missing fileId or cellId`)
      }
      if (event.kind === 'cell.audio.validate') {
        // Presence IS the vote (no is_active column), so a repeat validate is
        // an upsert that only moves the timestamp forward. The decided_ts
        // guard keeps an out-of-order replay from winding it back.
        stmts.push(
          db
            .prepare(
              `INSERT INTO cell_audio_validators (
                 project_id, file_id, cell_id, audio_id, username, decided_ts
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(project_id, file_id, cell_id, audio_id, username)
               DO UPDATE SET decided_ts = excluded.decided_ts
                 WHERE excluded.decided_ts > cell_audio_validators.decided_ts`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              p.audioId,
              event.author,
              event.serverTs,
            ),
        )
      } else {
        // A maintainer may strip somebody else's vote by naming them; anyone
        // else removes their own. The role gate lives in route.ts — by the
        // time an event reaches the projection the question is settled.
        const up = event.payload as EventPayloads['cell.audio.unvalidate']
        const targetUsername =
          typeof up.targetUsername === 'string' && up.targetUsername.trim()
            ? up.targetUsername.trim()
            : event.author
        stmts.push(
          db
            .prepare(
              `DELETE FROM cell_audio_validators
                WHERE project_id = ? AND file_id = ? AND cell_id = ?
                  AND audio_id = ? AND username = ?`,
            )
            .bind(event.projectId, event.fileId, event.cellId, p.audioId, targetUsername),
        )
      }
      // Re-derive the take's count from the table rather than incrementing it,
      // so a replay is idempotent — the same reason cells.endorsement_count is
      // a COUNT and not a running total.
      stmts.push(audioValidatorCountRecomputeStmt(db, event.projectId, event.fileId, event.cellId, p.audioId))
      return ['cell_audio', 'cell_audio_validators']
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
      const langMeta: Record<string, unknown> = p.projectionMeta
        ? { ...p.projectionMeta }
        : {}
      if (p.sourceLanguage) langMeta.sourceLanguage = p.sourceLanguage
      if (p.targetLanguage) langMeta.targetLanguage = p.targetLanguage
      if (p.sourceTextDirection) langMeta.sourceTextDirection = p.sourceTextDirection
      if (p.targetTextDirection) langMeta.targetTextDirection = p.targetTextDirection
      // Timeline-segment-model: the file's order lens lives in meta (JSON),
      // alongside languages — no files-table column needed.
      if (p.orderedBy) langMeta.orderedBy = p.orderedBy
      if (p.importManifest) langMeta.aquillaImport = p.importManifest
      if (p.r2Key) langMeta.r2Key = p.r2Key
      if (p.importFormat) langMeta.importFormat = p.importFormat
      if (p.parserVersion) langMeta.parserVersion = p.parserVersion
      const corpusMarker = usableCorpusMarker(p.corpusMarker)
      if (corpusMarker) langMeta.corpusMarker = corpusMarker
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
              ?, ?, ?, ?, ?,
              ?,
              0, 0, 0, NULL,
              ?, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint,
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
              updated_at = (extract(epoch from now()) * 1000)::bigint`,
          )
          .bind(
            event.fileId,
            event.projectId,
            p.name,
            p.role ?? null,
            p.kind ?? p.fileType ?? null,
            p.bookCode ?? null,
            p.sourceFileId ?? null,
            p.anchorFileId ?? null,
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
      // AQU-272: replay-safe soft-delete tombstone. Mirrors handlers/file-delete-restore.ts.
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
      // AQU-272: replay-safe restore. Mirrors handlers/file-delete-restore.ts.
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

    // ── Terminology concepts (AQU-1006 follow-up) ───────────────────────
    //
    // Every case here writes ONE concept, named by `conceptId` in the payload.
    // That is the whole reason these events exist: the settings blob they
    // replace could only express "here is the entire termbase", so a writer
    // working from a stale array silently deleted everyone else's entries.
    // No statement below may ever widen to `WHERE project_id = ?` alone.
    case 'term.create': {
      const p = event.payload as EventPayloads['term.create']
      stmts.push(
        db
          .prepare(
            // ON CONFLICT DO NOTHING, matching comment.create: the concept id
            // is client-minted, so a retried outbox flush or a rebuild replay
            // is an idempotent no-op rather than a duplicate concept.
            `INSERT INTO concepts (
              concept_id, project_id, source_term, renderings, notes,
              status, case_sensitive, match_options, created_by, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?::text::jsonb, ?, ?, ?, ?::text::jsonb, ?, ?, ?, NULL)
            ON CONFLICT(concept_id) DO NOTHING`,
          )
          .bind(
            p.conceptId,
            event.projectId,
            p.sourceTerm,
            JSON.stringify(p.renderings ?? []),
            p.notes ?? null,
            p.status,
            p.caseSensitive ? 1 : 0,
            p.match === undefined ? null : JSON.stringify(p.match),
            event.author,
            event.serverTs,
            event.serverTs,
          ),
      )
      return ['concepts']
    }

    case 'term.update': {
      const p = event.payload as EventPayloads['term.update']
      // COALESCE-per-column, not a whole-row UPDATE. An absent payload key
      // leaves that column alone, so two people editing different fields of
      // the same concept both survive — the per-field analogue of why this
      // table exists at all. `renderings` is the deliberate exception: a
      // rendering list has no per-item identity to merge on, so it replaces
      // wholesale when present and is left untouched when absent.
      stmts.push(
        db
          .prepare(
            `UPDATE concepts SET
               source_term    = COALESCE(?, source_term),
               renderings     = COALESCE(?::text::jsonb, renderings),
               notes          = COALESCE(?, notes),
               case_sensitive = COALESCE(?, case_sensitive),
               match_options  = COALESCE(?::text::jsonb, match_options),
               updated_at     = ?
             WHERE concept_id = ? AND project_id = ? AND deleted_at IS NULL`,
          )
          .bind(
            p.sourceTerm ?? null,
            p.renderings === undefined ? null : JSON.stringify(p.renderings),
            p.notes ?? null,
            p.caseSensitive === undefined ? null : p.caseSensitive ? 1 : 0,
            p.match === undefined ? null : JSON.stringify(p.match),
            event.serverTs,
            p.conceptId,
            event.projectId,
          ),
      )
      return ['concepts']
    }

    case 'term.delete': {
      const p = event.payload as EventPayloads['term.delete']
      // Soft-delete. The concept stays for the audit trail; the read route and
      // the partial index both filter on deleted_at IS NULL.
      stmts.push(
        db
          .prepare(
            `UPDATE concepts SET deleted_at = ?, updated_at = ?
             WHERE concept_id = ? AND project_id = ? AND deleted_at IS NULL`,
          )
          .bind(event.serverTs, event.serverTs, p.conceptId, event.projectId),
      )
      return ['concepts']
    }

    case 'term.approve': {
      const p = event.payload as EventPayloads['term.approve']
      // Only a draft is promotable. Guarding on status here (rather than
      // setting 'active' unconditionally) means an approve that races a
      // reject cannot resurrect a deprecated concept.
      stmts.push(
        db
          .prepare(
            `UPDATE concepts SET status = 'active', updated_at = ?
             WHERE concept_id = ? AND project_id = ?
               AND status IN ('draft', 'deprecated') AND deleted_at IS NULL`,
          )
          .bind(event.serverTs, p.conceptId, event.projectId),
      )
      return ['concepts']
    }

    case 'term.reject': {
      const p = event.payload as EventPayloads['term.reject']
      if (p.mode === 'deprecate') {
        stmts.push(
          db
            .prepare(
              `UPDATE concepts SET status = 'deprecated', updated_at = ?
               WHERE concept_id = ? AND project_id = ? AND deleted_at IS NULL`,
            )
            .bind(event.serverTs, p.conceptId, event.projectId),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `UPDATE concepts SET deleted_at = ?, updated_at = ?
               WHERE concept_id = ? AND project_id = ? AND deleted_at IS NULL`,
            )
            .bind(event.serverTs, event.serverTs, p.conceptId, event.projectId),
        )
      }
      return ['concepts']
    }

    case 'comment.create': {
      const p = event.payload as EventPayloads['comment.create']
      const scope: CommentScope = p.scope
      const scopeKind = scope.kind
      const fileId = scopeKind === 'cell' ? scope.fileId : scopeKind === 'file' ? scope.fileId : null
      const cellId = scopeKind === 'cell' ? scope.cellId : null
      // AQU-1233: author_id is always the human the credential was minted by —
      // permissions, foreign-comment floors and "my comments" filters all key
      // on it. The agent marker rides author_label, which is what the comments
      // UI renders (`authorLabel ?? authorId`), so a reviewer sees who is
      // answering AND that a tool typed it.
      const authorLabel = commentAuthorLabel(event.author, p.viaAgent)
      stmts.push(
        db
          .prepare(
            // AQU-692: created_for_translated stores the target-text snapshot
            // captured on the client at thread-creation time. Null for replies,
            // non-cell scopes, and legacy events that predate the field.
            //
            // AQU-1296: the conflict target is the PROJECT-SCOPED key. Comment
            // ids collide across projects (the importer leaves
            // `payload.commentId` as the raw legacy id), and conflicting on
            // `comment_id` alone meant the first project to claim an id owned
            // the only row that could exist — every later project's insert was
            // dropped in silence. Same-project replay is still a no-op, which
            // is what the deterministic commentCreateEventId design relies on.
            `INSERT INTO comments (
              comment_id, project_id, scope_kind, file_id, cell_id,
              parent_comment_id, body, resolved, author_id, author_label,
              created_at, updated_at, deleted_at, created_for_translated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?)
            ON CONFLICT(project_id, comment_id) DO NOTHING`,
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
            authorLabel,
            event.serverTs,
            event.serverTs,
            p.createdForTranslated ?? null,
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
      //
      // AQU-1296: `project_id` is part of the match on BOTH paths. Comment ids
      // are only unique within a project, so matching on `comment_id` alone let
      // an edit in project A rewrite project B's same-id row.
      const isMaintainer = (event.callerRole ?? 0) >= ROLE.MAINTAINER
      if (isMaintainer) {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = ?, updated_at = ?
               WHERE project_id = ? AND comment_id = ? AND deleted_at IS NULL`,
            )
            .bind(p.body, event.serverTs, event.projectId, p.commentId),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = ?, updated_at = ?
               WHERE project_id = ? AND comment_id = ? AND author_id = ? AND deleted_at IS NULL`,
            )
            .bind(p.body, event.serverTs, event.projectId, p.commentId, event.author),
        )
      }
      return ['comments']
    }

    case 'comment.delete': {
      const p = event.payload as EventPayloads['comment.delete']
      // Soft-delete: preserve the row so threads remain navigable.
      // Body cleared; deleted_at set. UI renders "[deleted]".
      // Maintainer+ foreign path: author_id check dropped (same logic as edit).
      // AQU-1296: project-scoped on both paths, as comment.edit above.
      const isMaintainer = (event.callerRole ?? 0) >= ROLE.MAINTAINER
      if (isMaintainer) {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = '', deleted_at = ?, updated_at = ?
               WHERE project_id = ? AND comment_id = ? AND deleted_at IS NULL`,
            )
            .bind(event.serverTs, event.serverTs, event.projectId, p.commentId),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `UPDATE comments SET body = '', deleted_at = ?, updated_at = ?
               WHERE project_id = ? AND comment_id = ? AND author_id = ? AND deleted_at IS NULL`,
            )
            .bind(event.serverTs, event.serverTs, event.projectId, p.commentId, event.author),
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
      // Foreign path: resolving someone else's thread — contributor(400)+
      //   (AQU-999; edit/delete stay at maintainer(600)).
      //   The route layer rejects the event before it reaches here when the
      //   caller is not the comment author and is below that floor. The
      //   projection logic is the same either way (no author filter on resolve
      //   — ownership was already enforced upstream).
      //
      // AQU-1296: project-scoped — resolving a thread in project A must not
      // flip project B's same-id thread.
      stmts.push(
        db
          .prepare(
            `UPDATE comments SET resolved = ?, updated_at = ?
             WHERE project_id = ? AND comment_id = ?
               AND parent_comment_id IS NULL AND deleted_at IS NULL`,
          )
          .bind(p.resolved ? 1 : 0, event.serverTs, event.projectId, p.commentId),
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
      // AQU-438: non-chain-mutating label assignment. Merges cast_name into
      // cells.metadata JSONB without touching value, event_id, or validated.
      // Applies to the SOURCE-side row (the cell's canonical reference lives
      // on the source side); the same cell_id lookup works for both sides.
      // AQU-439: also updates camera_state column when cameraState is present
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
      // AQU-646: the client's own line number for this row, merged into the
      // same JSONB bucket as cast_name. A SEPARATE statement rather than one
      // combined jsonb_build_object, because the two fields arrive
      // independently — an import that has a name but no line number must not
      // write a null over an existing one, and per-key merges commute, so a
      // concurrent cast.assign cannot clobber this either.
      if (p.lineNumber !== undefined && p.lineNumber !== null) {
        stmts.push(
          db
            .prepare(
              `UPDATE cells
               SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('line_number', ?::text)
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
            )
            .bind(p.lineNumber, event.projectId, event.fileId, event.cellId),
        )
      } else if (p.lineNumber === null) {
        stmts.push(
          db
            .prepare(
              `UPDATE cells
               SET metadata = CASE
                 WHEN metadata IS NULL THEN NULL
                 ELSE metadata - 'line_number'
               END
               WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
            )
            .bind(event.projectId, event.fileId, event.cellId),
        )
      }
      // AQU-439: optionally update camera_state when the payload carries it.
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

    case 'cell.lane.retime': {
      // AQU-646 round 6: per-LANE presentation timing, stored as metadata keys
      // on the source-side row (same JSONB merge discipline as cast.assign —
      // per-key merges commute, so concurrent cast/lane writes can't clobber
      // each other). The cell's start_ms/end_ms (the frozen source split) is
      // NEVER touched here. Per key: number sets, null clears (reset to the
      // default = follow the source split / section start), undefined no-ops.
      const p = event.payload as EventPayloads['cell.lane.retime']
      if (!event.fileId || !event.cellId) {
        throw new Error(`cell.lane.retime event ${event.id} is missing fileId or cellId`)
      }
      const laneKeys: Array<[key: string, value: number | null | undefined]> = [
        ['subtitle_start_ms', p.subtitleStartMs],
        ['subtitle_end_ms', p.subtitleEndMs],
        ['target_offset_ms', p.targetOffsetMs],
        ['target_start_ms', p.targetStartMs],
      ]
      for (const [key, value] of laneKeys) {
        if (value === undefined) continue
        if (typeof value === 'number' && Number.isFinite(value)) {
          stmts.push(
            db
              .prepare(
                `UPDATE cells
                 SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('${key}', ?::bigint)
                 WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
              )
              .bind(Math.round(value), event.projectId, event.fileId, event.cellId),
          )
        } else if (value === null) {
          stmts.push(
            db
              .prepare(
                `UPDATE cells
                 SET metadata = CASE
                   WHEN metadata IS NULL THEN NULL
                   ELSE metadata - '${key}'
                 END
                 WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
              )
              .bind(event.projectId, event.fileId, event.cellId),
          )
        }
        // Non-number, non-null values (corrupt replay data) are skipped.
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

    case 'file.timing.set': {
      // File-level timing mode — rebuild path; the dispatch path
      // (handlers/file-timing-set.ts) uses the same shared SQL builder.
      const p = event.payload as EventPayloads['file.timing.set']
      if (!event.fileId) {
        throw new Error(`file.timing.set event ${event.id} is missing fileId`)
      }
      stmts.push(buildFileTimingSetStmt(db, event.projectId, event.fileId, event.id, p.timingMode))
      return ['files']
    }

    case 'file.corpus.set': {
      const p = event.payload as EventPayloads['file.corpus.set']
      if (!event.fileId) {
        throw new Error(`file.corpus.set event ${event.id} is missing fileId`)
      }
      stmts.push(buildFileCorpusSetStmt(db, event.projectId, event.fileId, event.id, p.corpusMarker))
      return ['files']
    }

    case 'file.track.set': {
      // Per-track presentation overrides — rebuild path; the dispatch path
      // (handlers/file-track-set.ts) uses the same shared SQL builder.
      //
      // This case is a deliberately PERMISSIVE pass-through: rebuild.ts
      // replays already-accepted history through this very function, so
      // history that the live handler once accepted must never start being
      // rejected here. All shape validation lives in the handler, which only
      // ever sees new writes.
      const p = event.payload as EventPayloads['file.track.set']
      if (!event.fileId) {
        throw new Error(`file.track.set event ${event.id} is missing fileId`)
      }
      stmts.push(
        // Same rule on replay as on the live path, or a rebuild would
        // resurrect the kind-less junk the live path now refuses.
        buildFileTrackSetStmt(
          db, event.projectId, event.fileId, event.id, p.trackId, p.patch,
          trackPatchRequiresExisting(p.trackId, p.patch),
        ),
      )
      return ['files']
    }

    case 'source.cell.mirror': {
      // AQU-476: advance a downstream source cell to match the upstream.
      // UPSERT (the target.cell.commit INSERT…ON CONFLICT shape), NOT the
      // UPDATE-only source.cell.commit shape — mirrors routinely hit cells
      // with no local row yet (new upstream cells post-seed, first-ever
      // translations in target-consumption mode). Applied only when
      // payload.upstream.seq > cells.upstream_seq (monotonic, order-
      // insensitive, replay-safe) — this IS the arbitration; mirror events
      // are exempt from CHAIN_MUTATING_KINDS/chain-claims (see the const
      // below and its doc comment).
      const p = event.payload as EventPayloads['source.cell.mirror']
      if (!event.fileId || !event.cellId) {
        throw new Error(`source.cell.mirror event ${event.id} is missing fileId or cellId`)
      }
      const upstreamSeq = p.upstream.seq
      // The monotonic guard on INSERT…ON CONFLICT: Postgres always executes
      // the INSERT's SELECT source first, so a WHERE clause on the source
      // rows only gates whether a NEW row would be created; it does nothing
      // against an EXISTING row on conflict. We gate the UPSERT the same way
      // buildBulkSourceCellCreateStmt/create-case do it for chain claims:
      // append the guard as an EXISTS-style condition folded into the ON
      // CONFLICT's DO UPDATE ... WHERE clause (Postgres supports a WHERE on
      // the DO UPDATE action), so a stale/out-of-order mirror silently no-ops
      // against a row that's already ahead.
      if (p.deleted) {
        // Tombstone: never delete the row (so it stays visible + joinable
        // for the orphaned-target case) — stamp tombstoned_at instead.
        // Still monotonic-guarded: an older delete arriving after a newer
        // mirror already advanced the row must not stomp it.
        stmts.push(
          db
            .prepare(
              `INSERT INTO cells (
                project_id, file_id, cell_id, side, target_lang, value, value_html, type,
                canonical_ref, anchor_cell_id, event_id, source_event_id,
                last_editor, last_edit_at, validated, word_count, content_hash,
                upstream_event_id, upstream_seq, tombstoned_at
              ) VALUES (?, ?, ?, 'source', '', ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, 0, 0, ?, ?, ?, ?)
              ON CONFLICT (project_id, file_id, cell_id, side, target_lang) DO UPDATE SET
                event_id          = excluded.event_id,
                last_editor       = excluded.last_editor,
                last_edit_at      = excluded.last_edit_at,
                upstream_event_id = excluded.upstream_event_id,
                upstream_seq      = excluded.upstream_seq,
                tombstoned_at     = excluded.tombstoned_at
              WHERE cells.upstream_seq IS NULL OR cells.upstream_seq < excluded.upstream_seq`,
            )
            .bind(
              event.projectId,
              event.fileId,
              event.cellId,
              '', // tombstoned rows carry no live text; value stays as last-known on conflict (not overwritten — see WHERE)
              event.id,
              event.author,
              event.serverTs,
              contentHash(''),
              p.upstream.eventId,
              upstreamSeq,
              event.serverTs,
            ),
        )
        if (!opts?.deferFileCounters)
          stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
        return ['cells', 'files']
      }

      const value = p.value ?? ''
      const valueHtml = p.valueHtml ?? null
      const hash = contentHash(value)
      const wordCount = countWords(value)
      stmts.push(
        db
          .prepare(
            `INSERT INTO cells (
              project_id, file_id, cell_id, side, target_lang, value, value_html, type,
              canonical_ref, anchor_cell_id, event_id, source_event_id,
              last_editor, last_edit_at, validated, word_count, content_hash,
              start_ms, end_ms, medium, sequence_index, transcription, camera_state, metadata,
              upstream_event_id, upstream_seq, tombstoned_at
            ) VALUES (
              ?, ?, ?, 'source', '', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?,
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, NULL
            )
            ON CONFLICT (project_id, file_id, cell_id, side, target_lang) DO UPDATE SET
              value             = excluded.value,
              value_html        = excluded.value_html,
              type              = COALESCE(excluded.type, cells.type),
              canonical_ref     = COALESCE(excluded.canonical_ref, cells.canonical_ref),
              anchor_cell_id    = COALESCE(excluded.anchor_cell_id, cells.anchor_cell_id),
              event_id          = excluded.event_id,
              last_editor       = excluded.last_editor,
              last_edit_at      = excluded.last_edit_at,
              word_count        = excluded.word_count,
              content_hash      = excluded.content_hash,
              start_ms          = COALESCE(excluded.start_ms, cells.start_ms),
              end_ms            = COALESCE(excluded.end_ms, cells.end_ms),
              medium            = COALESCE(excluded.medium, cells.medium),
              sequence_index    = COALESCE(excluded.sequence_index, cells.sequence_index),
              transcription     = COALESCE(excluded.transcription, cells.transcription),
              camera_state      = COALESCE(excluded.camera_state, cells.camera_state),
              metadata          = COALESCE(excluded.metadata, cells.metadata),
              upstream_event_id = excluded.upstream_event_id,
              upstream_seq      = excluded.upstream_seq,
              tombstoned_at     = NULL
            WHERE cells.upstream_seq IS NULL OR cells.upstream_seq < excluded.upstream_seq`,
          )
          .bind(
            event.projectId,
            event.fileId,
            event.cellId,
            value,
            valueHtml,
            p.type ?? null,
            p.canonicalRef ?? null,
            p.anchorCellId ?? null,
            event.id,
            event.author,
            event.serverTs,
            wordCount,
            hash,
            p.startMs ?? null,
            p.endMs ?? null,
            p.medium ?? null,
            p.sequenceIndex ?? null,
            p.transcription ?? null,
            p.cameraState ?? null,
            p.metadata != null ? JSON.stringify(p.metadata) : null,
            p.upstream.eventId,
            upstreamSeq,
          ),
      )
      if (!opts?.deferFileCounters)
        stmts.push(fileCountersRecomputeStmt(db, event.projectId, event.fileId, event.serverTs))
      return ['cells', 'files']
    }

    case 'file.mirror': {
      // AQU-476: downstream `files` row for an upstream file created
      // post-seed. Idempotent upsert — no per-cell fold can conjure the file
      // row, so the mirror sync emits this explicitly for any new upstream
      // file id it hasn't seen. Not chain-mutating; no monotonic guard needed
      // (file rows have no competing writers other than the mirror itself
      // and the owning downstream's own file.rename/file.video.set, which
      // this does not touch).
      const p = event.payload as EventPayloads['file.mirror']
      if (!event.fileId) {
        throw new Error(`file.mirror event ${event.id} is missing fileId`)
      }
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
              NULL, NULL, NULL, NULL, NULL,
              ?,
              0, 0, 0, NULL,
              ?, (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint,
              ?
            )
            ON CONFLICT (id) DO UPDATE SET
              name = excluded.name,
              event_id = excluded.event_id,
              updated_at = (extract(epoch from now()) * 1000)::bigint`,
          )
          .bind(
            event.fileId,
            event.projectId,
            p.name,
            event.id,
            event.author,
            JSON.stringify(p.meta ?? {}),
          ),
      )
      return ['files']
    }

    case 'link.cursor.advance': {
      // AQU-476: pure audit-trail record — no cells/files projection. The
      // events row itself (already inserted by the caller) IS the record;
      // this case exists only so the exhaustiveness check + dispatch table
      // stay complete. Nothing to add to `stmts`.
      return []
    }

    case 'target.cell.repin': {
      // AQU-478: "accept upstream change as-is." Updates ONLY the target
      // row's source_event_id — value, event_id (chain head), validated,
      // and endorsement_count are all deliberately untouched (spec §7:
      // "validators are the scarce bilingual experts; a stale flag plus an
      // oversight count is the honest signal"). Non-chain-mutating (not in
      // CHAIN_MUTATING_KINDS): repin doesn't compete for the chain slot.
      //
      // Guarded by expectedTargetEventId: the WHERE clause requires the
      // target row's CURRENT event_id to still equal the head the reviewer
      // observed when they opened the review panel. If a translator
      // re-committed in the meantime, cells.event_id has already moved past
      // expectedTargetEventId and this UPDATE matches zero rows — a silent,
      // safe no-op (the route/UI layer detects zero-rows-affected and
      // reports the cell as skipped for bulk repin).
      const p = event.payload as EventPayloads['target.cell.repin']
      if (!event.fileId || !event.cellId) {
        throw new Error(`target.cell.repin event ${event.id} is missing fileId or cellId`)
      }
      stmts.push(
        db
          .prepare(
            `UPDATE cells
                SET source_event_id = ?
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'
                AND event_id = ?`,
          )
          .bind(
            p.sourceEventId,
            event.projectId,
            event.fileId,
            event.cellId,
            p.expectedTargetEventId,
          ),
      )
      return ['cells']
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
 * Shared meta-merge for the file's sidebar corpus group. Same shape as
 * buildFileTimingSetStmt (one files.meta JSON key, merged or removed).
 * Null / blank clears the key — the file lands in Ungrouped.
 */
export function buildFileCorpusSetStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  eventId: string,
  corpusMarker: string | null,
): AquillaStatement {
  const NOW = "(extract(epoch from now()) * 1000)::bigint"
  const usable = usableCorpusMarker(corpusMarker)
  if (usable == null) {
    return db
      .prepare(
        `UPDATE files
            SET meta = (COALESCE(NULLIF(meta, ''), '{}')::jsonb - 'corpusMarker')::text,
                event_id = ?, updated_at = ${NOW}
          WHERE id = ? AND project_id = ?`,
      )
      .bind(eventId, fileId, projectId)
  }
  return db
    .prepare(
      `UPDATE files
          SET meta = (COALESCE(NULLIF(meta, ''), '{}')::jsonb || jsonb_build_object('corpusMarker', ?::text))::text,
              event_id = ?, updated_at = ${NOW}
        WHERE id = ? AND project_id = ?`,
    )
    .bind(usable, eventId, fileId, projectId)
}

export function buildFileTimingSetStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  eventId: string,
  timingMode: 'dubbing' | 'audioFirst' | null,
): AquillaStatement {
  const NOW = "(extract(epoch from now()) * 1000)::bigint"
  if (timingMode == null) {
    return db
      .prepare(
        `UPDATE files
            SET meta = (COALESCE(NULLIF(meta, ''), '{}')::jsonb - 'timingMode')::text,
                event_id = ?, updated_at = ${NOW}
          WHERE id = ? AND project_id = ?`,
      )
      .bind(eventId, fileId, projectId)
  }
  return db
    .prepare(
      `UPDATE files
          SET meta = (COALESCE(NULLIF(meta, ''), '{}')::jsonb || jsonb_build_object('timingMode', ?::text))::text,
              event_id = ?, updated_at = ${NOW}
        WHERE id = ? AND project_id = ?`,
    )
    .bind(timingMode, eventId, fileId, projectId)
}

/**
 * Shared meta-merge for ONE timeline track's presentation overrides, kept in
 * files.meta under `trackOverrides` keyed by track id. Used by both the live
 * handler (handlers/file-track-set.ts) and the rebuild projection case above.
 * A null patch removes the whole entry — a user-added track disappears, a
 * default track falls back to pure defaults.
 *
 * The upsert merges per FIELD, not per entry: A renaming a track while B
 * reorders the same track leaves BOTH changes standing, because each `||`
 * only replaces the keys it actually carries (last-write-wins per field
 * instead of per track). jsonb_set is deliberately not used — it silently
 * no-ops when the parent key ('trackOverrides') does not exist yet, which is
 * precisely the first-override case.
 *
 * WARNING: jsonb_strip_nulls is RECURSIVE. It is what turns `{"name": null}`
 * into "drop the name override", so patches MUST stay FLAT — a nested,
 * object-valued field would have its own nulls silently eaten too. The
 * handler's key allow-list is what enforces flatness today; anyone adding an
 * object-valued patch field later has to revisit this builder first.
 */
export function buildFileTrackSetStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  eventId: string,
  trackId: string,
  patch: EventPayloads['file.track.set']['patch'],
  /**
   * Must the track already be in `trackOverrides` for this write to apply?
   * (2026-08-27)
   *
   * True for any patch that cannot bring a track into being — one carrying no
   * `kind`. Without it, `{order: 1}` for an id that does not exist merged a
   * kind-less entry into `files.meta`, which `mergeTrackOverrides` then skips
   * when rendering (`isTrackKind(patch.kind)` fails): invisible in the UI,
   * untargetable by any control, and unremovable, because removal is
   * `patch: null` and THAT is gated. Creation ungated, deletion gated — junk
   * that only re-enabling the setting could clear, on a blob read on every
   * file listing.
   *
   * Enforced in SQL because the handler is synchronous and never loads the
   * file's meta. A failing condition is a no-op rather than an error, which is
   * also the right answer for the race it incidentally fixes: a reorder that
   * arrives after someone else's delete no longer resurrects the track as junk.
   */
  requireExisting = false,
): AquillaStatement {
  const NOW = "(extract(epoch from now()) * 1000)::bigint"
  const META = "COALESCE(NULLIF(meta, ''), '{}')::jsonb"
  if (patch == null) {
    return db
      .prepare(
        `UPDATE files
            SET meta = (${META} #- ARRAY['trackOverrides', ?::text])::text,
                event_id = ?, updated_at = ${NOW}
          WHERE id = ? AND project_id = ?`,
      )
      .bind(trackId, eventId, fileId, projectId)
  }
  // The patch binds through ::text::jsonb: postgres.js re-encodes an
  // already-serialized string when the parameter is typed jsonb directly, so
  // the entry would land as a JSON string instead of an object (the
  // json-bind-contract test greps the tree for exactly that mistake). trackId
  // binds twice — once as the key written, once to read the entry it merges
  // onto.
  // `jsonb_exists(...)` rather than the `?` key-exists OPERATOR: `?` is also
  // this driver's bind placeholder, and the two cannot share a statement.
  const existsTerm = requireExisting
    ? ` AND jsonb_exists(COALESCE(${META} -> 'trackOverrides', '{}'::jsonb), ?::text)`
    : ''
  const stmt = db.prepare(
    `UPDATE files
        SET meta = (${META} || jsonb_build_object('trackOverrides',
              COALESCE(${META} -> 'trackOverrides', '{}'::jsonb) || jsonb_build_object(?::text,
                jsonb_strip_nulls(COALESCE(${META} -> 'trackOverrides' -> ?::text, '{}'::jsonb) || ?::text::jsonb))))::text,
            event_id = ?, updated_at = ${NOW}
      WHERE id = ? AND project_id = ?${existsTerm}`,
  )
  return requireExisting
    ? stmt.bind(trackId, trackId, JSON.stringify(patch), eventId, fileId, projectId, trackId)
    : stmt.bind(trackId, trackId, JSON.stringify(patch), eventId, fileId, projectId)
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
 *
 * AQU-476: `source.cell.mirror` is deliberately NOT in this set. A mirror
 * replicates an ordering the UPSTREAM already arbitrated — running it
 * through the downstream's first-child claims would let an older sync's
 * fold win the chain slot over a newer one's, stranding a cell on stale
 * content behind an advanced cursor. Mirror events carry parentId: null
 * and apply under their own monotonic `upstream_seq` guard instead (see
 * the 'source.cell.mirror' case above).
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
 * AQU-931: whether an event COMPETES for its AD-2 chain slot. Chain-mutating
 * kinds arbitrate first-child-of-parent — EXCEPT a parent-null cell delete.
 * That shape is the trusted tombstone (the AQU-747 mapper retraction and the
 * AQU-910 deletion-by-absence pass both mint deletes with parentId null): it
 * extends no chain, and arbitrating it at the genesis slot makes it LOSE to
 * the cell's own `source.cell.create` on replay — so a projection rebuild
 * silently resurrected every retracted cell. All three arbitration sites
 * (the live claim in handlers/cell-events.ts, rebuild.ts's in-memory
 * childKey, and isWinningChild's sibling filter) must use this predicate —
 * or replay diverges from live.
 */
export function isChainArbitrated(kind: string, parentId: string | null | undefined): boolean {
  if (!CHAIN_MUTATING_KINDS.has(kind)) return false
  if (parentId == null && (kind === 'source.cell.delete' || kind === 'target.cell.delete')) {
    return false
  }
  return true
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
  // A non-arbitrated event (parent-null delete tombstone) never competes —
  // and never blocks a competitor (see the sibling loop below). AQU-931.
  if (!isChainArbitrated(candidate.kind, candidate.parentId)) return true

  // Build the SQL with a NULL-aware parent_id predicate. We also filter
  // to chain-mutating kinds so a sibling validation event doesn't block a
  // legitimate commit from advancing the projection.
  //
  // Siblings only compete within the same side/lane namespace: source edits,
  // the default target lane, and every named target lane advance separately.
  // `payload` is TEXT, so qualification runs in JS (dialect-portable; no
  // jsonb cast). The LIMIT bounds the scan; a truncated scan can only produce
  // a false "winner", while the atomic chain_claims gate remains authoritative
  // for in-flight races.
  const parentIsNull = candidate.parentId === null || candidate.parentId === undefined
  const kindList = [...CHAIN_MUTATING_KINDS].map((k) => `'${k}'`).join(', ')
  const sql = parentIsNull
    ? `SELECT id, server_seq, kind, payload FROM events
       WHERE project_id = ? AND file_id = ? AND cell_id = ?
         AND parent_id IS NULL
         AND kind IN (${kindList})
       ORDER BY server_seq ASC, id ASC
       LIMIT 100`
    : `SELECT id, server_seq, kind, payload FROM events
       WHERE project_id = ? AND file_id = ? AND cell_id = ? AND parent_id = ?
         AND kind IN (${kindList})
       ORDER BY server_seq ASC, id ASC
       LIMIT 100`

  const stmt = parentIsNull
    ? db.prepare(sql).bind(candidate.projectId, candidate.fileId, candidate.cellId)
    : db.prepare(sql).bind(candidate.projectId, candidate.fileId, candidate.cellId, candidate.parentId)

  const { results } = await stmt.all<{ id: string; server_seq: number; kind: string; payload: string }>()

  const candidateParentKey = eventQualifiedParentKey(
    candidate.parentId,
    candidate.kind,
    candidate.payload,
  )
  for (const row of results ?? []) {
    // Non-arbitrated siblings (parent-null delete tombstones) hold no slot —
    // they must not beat a later genesis create to it (AQU-931).
    if (parentIsNull && !isChainArbitrated(row.kind, null)) continue
    let rowPayload: unknown = null
    try {
      rowPayload = JSON.parse(row.payload)
    } catch {
      // Invalid historical payloads cannot qualify a named target lane, but
      // still arbitrate deterministically in their side/default namespace.
    }
    const rowParentKey = eventQualifiedParentKey(candidate.parentId, row.kind, rowPayload)
    if (rowParentKey !== candidateParentKey) continue

    // The earliest same-namespace sibling is this candidate → first child (or an
    // idempotent replay of the winner); anything else beat us to the slot.
    return row.id === candidate.id
  }

  // No same-namespace sibling yet → this one is the first child, wins.
  return true
}
