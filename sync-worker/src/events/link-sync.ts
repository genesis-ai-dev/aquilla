// FRO-476: mirror sync engine — the single propagation function every
// trigger (lazy pull on file open, push accelerator, manual "check now")
// funnels into. See the linked-projects design spec §5 for the full
// contract; this module is the tracer-bullet implementation for
// `consumes: 'source'` links (slice 1).
//
// mirrorSync(db, downstreamProjectId):
//   1. Load the link (upstream id, mode, consumes, cursor). Short-circuits
//      for clone mode / no link (nothing to do).
//   2. Freshness probe: max LANE-RELEVANT upstream server_seq vs cursor. If
//      not behind, return immediately (no DB writes).
//   3. Delta = upstream events in the lane set, server_seq > cursor, folded
//      to latest-per-cell (a seq window, not per-event work).
//   4. For each new upstream file: emit file.mirror.
//   5. For each folded cell: hash-equal → skip (no event, no write);
//      upstream-deleted → tombstone mirror; else → content mirror.
//   6. Batch all mirror events through the canonical events INSERT +
//      buildEventProjectionStmts (front-door — same projection code the live
//      HTTP path uses), respecting BATCH_LIMIT.
//   7. Cursor = GREATEST(cursor, head); emit link.cursor.advance only when
//      the fold produced at least one cell/file mirror.
//
// Idempotent + resumable: mirror event ids are deterministic
// (hash(downstreamProjectId + upstreamEventId)), so a crashed or re-run sync
// dedupes via the events PK; the projection's monotonic upstream_seq guard
// makes application order-insensitive; the cursor write only ever advances.
//
// This module calls buildEventProjectionStmts directly (in-process) rather
// than going through authorize()/POST /events — there is no client JWT for a
// server-authored mirror event, and this *is* the front door for this kind
// (the projection function), matching the "front-door events, never raw
// inserts" rule applied to server-authored writes elsewhere (see
// docs/superpowers/specs/2026-07-06-… §11 for the analogous adapter-service
// contract).

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import {
  buildEventProjectionStmts,
  contentHash,
  fileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import { buildBulkEventInsertStmt, allocateSeqRange, type SeqEventInsertRow } from './event-insert'
import type { EventPayloads } from './types'
import { fullProgressRecomputeStmts } from './progress-projection'

const BATCH_LIMIT = 100
const MIRROR_AUTHOR = 'link-sync'
const MIRROR_SCHEMA_VERSION = 1

/** Lane-relevant kinds for `consumes: 'source'` links (slice 1). Comments,
 *  audio attaches, back-translations, and validations never mirror — a probe
 *  that counted them would make every downstream read "behind" after any
 *  upstream noise event. */
const LANE_KINDS_SOURCE = [
  'source.cell.create',
  'source.cell.commit',
  'source.cell.delete',
  'source.cell.mirror',
  'cell.retime',
  'cast.assign',
  'file.create',
] as const

/** FRO-477: additional lane-relevant kinds for `consumes: 'target'` links —
 *  the chain case (this project's source lane IS the upstream's translation
 *  lane). Structural events (source.cell.create/cell.retime/cast.assign/
 *  file.create) still matter in target-consumption mode: the merge takes
 *  structure from the upstream's SOURCE row (§2), so a structural-only
 *  upstream change must still advance the lane head / trigger a re-fold.
 *  `target.cell.commit` and `cell.validate`/`cell.unvalidate` are ADDED on
 *  top of the source set — never instead of it. */
const LANE_KINDS_TARGET_EXTRA = [
  'target.cell.commit',
  'cell.validate',
  'cell.unvalidate',
] as const

function laneKindsFor(consumes: string | null): readonly string[] {
  return consumes === 'target' ? [...LANE_KINDS_SOURCE, ...LANE_KINDS_TARGET_EXTRA] : LANE_KINDS_SOURCE
}

export interface LinkRow {
  id: string
  source_project_id: string | null
  source_link_mode: string | null
  source_link_consumes: string | null
  source_link_gate: string | null
  source_link_cursor: number
}

export async function loadLink(db: AquillaDb, downstreamProjectId: string): Promise<LinkRow | null> {
  return db
    .prepare(
      `SELECT id, source_project_id, source_link_mode, source_link_consumes,
              source_link_gate, source_link_cursor
       FROM projects WHERE id = ?`,
    )
    .bind(downstreamProjectId)
    .first<LinkRow>()
}

/** Max lane-relevant upstream server_seq — the cheap freshness probe (§4).
 *  `consumes` selects the lane set: 'target' links also watch
 *  target.cell.commit / cell.validate / cell.unvalidate (§5) on top of the
 *  always-watched structural kinds. Defaults to the source-only set when
 *  omitted (backward compatible with FRO-476 call sites). */
export async function laneRelevantHeadSeq(
  db: AquillaDb,
  upstreamProjectId: string,
  consumes: string | null = 'source',
): Promise<number> {
  const kindList = laneKindsFor(consumes).map((k) => `'${k}'`).join(', ')
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(server_seq), 0) AS head
       FROM events WHERE project_id = ? AND kind IN (${kindList})`,
    )
    .bind(upstreamProjectId)
    .first<{ head: number | string }>()
  return Number(row?.head ?? 0)
}

interface UpstreamDeltaRow {
  id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  payload: string
  server_seq: number
}

interface FoldedCell {
  /** The UPSTREAM file id (the delta is read from upstream events). Convert
   *  via deterministicDownstreamFileId() before writing to the downstream's
   *  own `cells`/`files` rows — see that function's doc comment for why. */
  fileId: string
  cellId: string
  eventId: string
  seq: number
  deleted: boolean
  value: string
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  anchorCellId: string | null
  startMs: number | null
  endMs: number | null
  /** FRO-477: only populated by the consumes='target' merge fold (§2) — the
   *  consumes='source' fold leaves these undefined/null and the emit loop's
   *  payload construction omits them (matching slice-1 behavior exactly). */
  sequenceIndex?: number | null
  transcription?: string | null
  cameraState?: string | null
  metadata?: Record<string, unknown> | null
}

/** Deterministic uuid-shaped hash of an arbitrary key. Not cryptographic —
 *  only needs to be stable + collision-unlikely across its keyspace, which
 *  is what the callers below rely on (events PK idempotency; files PK
 *  identity). */
function deterministicUuid(key: string): string {
  // djb2-style multi-lane hash (reusing the existing content-hash primitive
  // with different seeds) folded into a UUIDv4-shaped string.
  const h1 = contentHash(key)
  const h2 = contentHash(`${key}\0salt2`)
  const h3 = contentHash(`${h1}${h2}`)
  const h4 = contentHash(`${h2}${h1}`)
  const hex = (h1 + h2 + h3 + h4).slice(0, 32).padEnd(32, '0')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${'89ab'[parseInt(hex[16] ?? '0', 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  )
}

/** Deterministic mirror event id: uuid-shaped hash of
 *  (downstreamProjectId, upstreamEventId) so replays/dual-triggers dedupe
 *  via the events PK idempotency path (readExistingEventIds/ON CONFLICT). */
export function deterministicMirrorEventId(downstreamProjectId: string, upstreamEventId: string): string {
  return deterministicUuid(`${downstreamProjectId}\0${upstreamEventId}`)
}

/**
 * Deterministic downstream file id for a mirrored upstream file.
 *
 * `files.id` is a GLOBAL primary key (no `project_id` in its uniqueness,
 * unlike `cells`/`chain_claims`/etc., which are all `(project_id, file_id,
 * …)`) — so a mirrored file CANNOT reuse the upstream's raw file id without
 * colliding with the upstream's own `files` row. Every downstream gets its
 * own deterministic id derived from (downstreamProjectId, upstreamFileId),
 * stable across re-syncs (so a re-run finds the SAME downstream file row,
 * not a duplicate) and distinct per downstream (so N downstreams of one
 * upstream never collide with each other either).
 *
 * `cell_id` has no such problem — `cells`' PK already includes
 * `project_id`, so the same `cell_id` string can and does appear in both
 * projects' `cells` rows, keyed apart by `project_id`. Only the file
 * identity needs this indirection.
 */
export function deterministicDownstreamFileId(downstreamProjectId: string, upstreamFileId: string): string {
  return deterministicUuid(`file\0${downstreamProjectId}\0${upstreamFileId}`)
}

/** Fold upstream lane events (server_seq > cursor) to latest-per-cell state,
 *  plus the set of new file ids seen. A seq window, not per-event work. */
async function loadDelta(
  db: AquillaDb,
  upstreamProjectId: string,
  sinceSeq: number,
): Promise<{ cells: Map<string, FoldedCell>; fileIds: Set<string> }> {
  const kindList = LANE_KINDS_SOURCE.map((k) => `'${k}'`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT id, file_id, cell_id, kind, payload, server_seq
       FROM events
       WHERE project_id = ? AND server_seq > ? AND kind IN (${kindList})
       ORDER BY server_seq ASC`,
    )
    .bind(upstreamProjectId, sinceSeq)
    .all<UpstreamDeltaRow>()

  const cells = new Map<string, FoldedCell>()
  const fileIds = new Set<string>()

  for (const row of results) {
    if (!row.file_id) continue
    fileIds.add(row.file_id)
    if (!row.cell_id) continue
    const key = `${row.file_id}\0${row.cell_id}`
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.kind === 'source.cell.create' || row.kind === 'source.cell.mirror') {
      cells.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        deleted: false,
        value: typeof payload.value === 'string' ? payload.value : '',
        valueHtml: typeof payload.valueHtml === 'string' ? payload.valueHtml : null,
        type: typeof payload.type === 'string' ? payload.type : null,
        canonicalRef: typeof payload.canonicalRef === 'string' ? payload.canonicalRef : null,
        anchorCellId: typeof payload.anchorCellId === 'string' ? payload.anchorCellId : null,
        startMs: typeof payload.startMs === 'number' ? payload.startMs : null,
        endMs: typeof payload.endMs === 'number' ? payload.endMs : null,
      })
    } else if (row.kind === 'source.cell.commit') {
      const prev = cells.get(key)
      cells.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        deleted: false,
        value: typeof payload.value === 'string' ? payload.value : '',
        valueHtml: typeof payload.valueHtml === 'string' ? payload.valueHtml : null,
        type: prev?.type ?? null,
        canonicalRef: prev?.canonicalRef ?? null,
        anchorCellId: prev?.anchorCellId ?? null,
        startMs: prev?.startMs ?? null,
        endMs: prev?.endMs ?? null,
      })
    } else if (row.kind === 'source.cell.delete') {
      const prev = cells.get(key)
      cells.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        deleted: true,
        value: '',
        valueHtml: null,
        type: prev?.type ?? null,
        canonicalRef: prev?.canonicalRef ?? null,
        anchorCellId: prev?.anchorCellId ?? null,
        startMs: prev?.startMs ?? null,
        endMs: prev?.endMs ?? null,
      })
    }
    // cell.retime / cast.assign / file.create: structural-only kinds that
    // move the lane-relevant head but don't fold into FoldedCell content in
    // slice 1 (per spec §15 open question — "mirror metadata always, or only
    // before downstream has diverged?"). They still count toward `head` so
    // the freshness probe and cursor advance correctly; a future slice can
    // extend the fold to carry timing/cast deltas.
  }

  return { cells, fileIds }
}

// ─────────────────────────────────────────────────────────────────────────
// FRO-477: consumes='target' — the chain case. The downstream's SOURCE lane
// mirrors the upstream's TRANSLATIONS (target lane), merged with structural
// fields (type/refs/timing/sequence/cast) from the upstream cell's OWN
// source row (§2 — target rows are born with no structure; a dubbing chain
// needs all of it).
// ─────────────────────────────────────────────────────────────────────────

interface UpstreamTargetState {
  fileId: string
  cellId: string
  eventId: string
  seq: number
  value: string
  valueHtml: string | null
  /** Latest server_seq of ANY event (commit or validate/unvalidate) that
   *  touched this cell's target chain — used to decide which of a commit vs.
   *  a later validate/unvalidate "wins" for gate=validated's current-head
   *  test below. Not emitted anywhere; purely a fold-ordering aid. */
  lastTouchedSeq: number
  /** True iff, as of the latest touch, the CURRENT commit (eventId) has an
   *  active validator (a validate after this commit with no subsequent
   *  unvalidate of the same validator... approximated here as "any validate
   *  targeting this eventId landed after it, and no unvalidate of the same
   *  validator landed after THAT" — see fold loop below for the precise
   *  bookkeeping). */
  validated: boolean
}

/** Fold upstream target-lane events (server_seq > cursor) to latest
 *  commit-state per cell, tracking whether the CURRENT commit has an active
 *  validation (needed for gate='validated'). Mirrors the projection's own
 *  cell_validators bookkeeping at a coarse per-delta-window grain — good
 *  enough because the mirror only cares about "is the current head validated
 *  right now," which loadUpstreamTargetValidated (below) double-checks
 *  directly against the upstream's live `cells.validated` column for the
 *  window's final state (this fold only needs to know the correct eventId
 *  per gate, not to be the source of truth for validation booleans). */
async function loadUpstreamTargetDelta(
  db: AquillaDb,
  upstreamProjectId: string,
  sinceSeq: number,
): Promise<{ states: Map<string, UpstreamTargetState>; touchedKeys: Set<string> }> {
  const { results } = await db
    .prepare(
      `SELECT id, file_id, cell_id, kind, payload, server_seq
       FROM events
       WHERE project_id = ? AND server_seq > ?
         AND kind IN ('target.cell.commit', 'cell.validate', 'cell.unvalidate')
       ORDER BY server_seq ASC`,
    )
    .bind(upstreamProjectId, sinceSeq)
    .all<UpstreamDeltaRow>()

  const states = new Map<string, UpstreamTargetState>()
  // Every cell touched by ANY target-lane event this window, independent of
  // whether the fold below could resolve a full commit+validated state for
  // it. A bare cell.validate for a commit that landed BEFORE this window
  // (re-validating an already-mirrored cell with no intervening structural
  // change) still needs its cell visited by loadDeltaTargetConsumption's
  // caller — it falls back to loadUpstreamTargetCurrentState for the actual
  // gated text (§5) — otherwise a "re-validate with no accompanying commit
  // in this window" silently never re-folds.
  const touchedKeys = new Set<string>()
  for (const row of results) {
    if (!row.file_id || !row.cell_id) continue
    const key = `${row.file_id}\0${row.cell_id}`
    touchedKeys.add(key)
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.kind === 'target.cell.commit') {
      states.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        value: typeof payload.value === 'string' ? payload.value : '',
        valueHtml: typeof payload.valueHtml === 'string' ? payload.valueHtml : null,
        lastTouchedSeq: row.server_seq,
        // A new commit resets validation (same rule as the projection: a
        // moved chain head starts unvalidated until the next cell.validate).
        validated: false,
      })
    } else if (row.kind === 'cell.validate') {
      const prev = states.get(key)
      if (prev && prev.eventId === (typeof payload.editEventId === 'string' ? payload.editEventId : undefined)) {
        states.set(key, { ...prev, validated: true, lastTouchedSeq: row.server_seq })
      }
      // A validate for an eventId that isn't the latest-known commit in
      // THIS delta window (e.g. the commit landed before `sinceSeq`) can't
      // be folded here — the key is still in `touchedKeys`, so the caller
      // falls back to loadUpstreamTargetCurrentState's direct read of the
      // upstream's live `cells.validated` column.
    } else if (row.kind === 'cell.unvalidate') {
      const prev = states.get(key)
      if (prev) {
        states.set(key, { ...prev, validated: false, lastTouchedSeq: row.server_seq })
      }
    }
  }
  return { states, touchedKeys }
}

/** For cells whose commit predates the delta window (so
 *  loadUpstreamTargetDelta never saw the commit event and can't know its
 *  validated status from folding alone), read the upstream's live
 *  `cells.validated` flag directly — the projection already maintains this
 *  as "current chain head has >= threshold validators" (event-projection.ts
 *  cell.validate case), so it's the authoritative answer for "is the
 *  current upstream target head validated right now." */
async function loadUpstreamTargetCurrentState(
  db: AquillaDb,
  upstreamProjectId: string,
  cellKeys: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, { eventId: string; value: string; valueHtml: string | null; validated: boolean }>> {
  const state = new Map<string, { eventId: string; value: string; valueHtml: string | null; validated: boolean }>()
  if (cellKeys.length === 0) return state
  const placeholders = cellKeys.map(() => '(?, ?)').join(', ')
  const binds: unknown[] = [upstreamProjectId]
  for (const k of cellKeys) binds.push(k.fileId, k.cellId)
  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, event_id, value, value_html, validated FROM cells
       WHERE project_id = ? AND side = 'target' AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{ file_id: string; cell_id: string; event_id: string; value: string; value_html: string | null; validated: number | boolean }>()
  for (const r of results) {
    state.set(`${r.file_id}\0${r.cell_id}`, {
      eventId: r.event_id,
      value: r.value,
      valueHtml: r.value_html,
      validated: r.validated === true || r.validated === 1,
    })
  }
  return state
}

/** Upstream SOURCE-row structural fields for a set of cells — the merge's
 *  "structure" half when consumes='target' (§2: a target row has no type/
 *  canonicalRef/anchor/timing/sequence/cast; the merge borrows all of it
 *  from the upstream cell's OWN source row). */
async function loadUpstreamSourceStructure(
  db: AquillaDb,
  upstreamProjectId: string,
  cellKeys: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, {
  type: string | null
  canonicalRef: string | null
  anchorCellId: string | null
  startMs: number | null
  endMs: number | null
  sequenceIndex: number | null
  transcription: string | null
  cameraState: string | null
  metadata: Record<string, unknown> | null
}>> {
  const out = new Map<string, {
    type: string | null
    canonicalRef: string | null
    anchorCellId: string | null
    startMs: number | null
    endMs: number | null
    sequenceIndex: number | null
    transcription: string | null
    cameraState: string | null
    metadata: Record<string, unknown> | null
  }>()
  if (cellKeys.length === 0) return out
  const placeholders = cellKeys.map(() => '(?, ?)').join(', ')
  const binds: unknown[] = [upstreamProjectId]
  for (const k of cellKeys) binds.push(k.fileId, k.cellId)
  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, type, canonical_ref, anchor_cell_id, start_ms, end_ms,
              sequence_index, transcription, camera_state, metadata
       FROM cells
       WHERE project_id = ? AND side = 'source' AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{
      file_id: string
      cell_id: string
      type: string | null
      canonical_ref: string | null
      anchor_cell_id: string | null
      start_ms: number | string | null
      end_ms: number | string | null
      sequence_index: number | string | null
      transcription: string | null
      camera_state: string | null
      metadata: Record<string, unknown> | null
    }>()
  for (const r of results) {
    out.set(`${r.file_id}\0${r.cell_id}`, {
      type: r.type,
      canonicalRef: r.canonical_ref,
      anchorCellId: r.anchor_cell_id,
      startMs: r.start_ms == null ? null : Number(r.start_ms),
      endMs: r.end_ms == null ? null : Number(r.end_ms),
      sequenceIndex: r.sequence_index == null ? null : Number(r.sequence_index),
      transcription: r.transcription,
      cameraState: r.camera_state,
      metadata: r.metadata,
    })
  }
  return out
}

/**
 * Target-consumption delta fold (§2, §5). Returns the SAME shape as
 * loadDelta() — `{ cells, fileIds }` — so the rest of mirrorSync (hash
 * check, upsert, cursor advance) is unaware of which consumption mode
 * produced it.
 *
 * Per cell:
 *   - structure (type/canonicalRef/anchorCellId/startMs/endMs/…) comes from
 *     the upstream cell's SOURCE row (always current-state read, not
 *     delta-folded — structural upstream events don't carry the full cell
 *     shape per-event the way source.cell.create does, so re-reading current
 *     state is simpler and correct: the projection's own COALESCE-merge
 *     upsert means an unrelated structural field never regresses).
 *   - text (value/valueHtml) comes from the upstream cell's TARGET row,
 *     gated:
 *       gate='head'      -> whatever the target lane's current commit is.
 *       gate='validated' -> only if that commit is CURRENTLY validated
 *                            (cells.validated=1 upstream); a draft commit
 *                            over a validated cell mirrors NOTHING new until
 *                            the new head is itself validated (issue AC #2).
 *   - Upstream cells with no target commit yet produce NO folded row (the
 *     cell simply doesn't exist downstream until first gated commit, §2).
 */
async function loadDeltaTargetConsumption(
  db: AquillaDb,
  upstreamProjectId: string,
  sinceSeq: number,
  gate: string | null,
  /** The lane-relevant head seq for this sync (laneRelevantHeadSeq's
   *  result). Used as the fold seq for cells whose gated text comes from
   *  loadUpstreamTargetCurrentState's fallback (commit predates the delta
   *  window) — `head` is always a safe, correct monotonic ceiling for the
   *  projection's upstream_seq guard in that case, since the mirror sync
   *  never processes anything past `head` in one run. */
  head: number,
): Promise<{ cells: Map<string, FoldedCell>; fileIds: Set<string> }> {
  // 1. Structural-lane delta (reuses the source-consumption fold verbatim —
  //    it already extracts file ids + per-cell source-side fields/deletes).
  const structuralDelta = await loadDelta(db, upstreamProjectId, sinceSeq)

  // 2. Target-lane delta: which cells had a target commit or validation
  //    change in this window.
  const { states: targetDelta, touchedKeys: targetTouchedKeys } = await loadUpstreamTargetDelta(
    db,
    upstreamProjectId,
    sinceSeq,
  )

  // Union of cell keys touched by either lane this window. `targetTouchedKeys`
  // (not `targetDelta.keys()`) is used here — a bare cell.validate/unvalidate
  // whose commit predates the window still touches the cell (§5's "re-
  // validate with no accompanying commit this window" case) even though the
  // fold above couldn't resolve a full state for it.
  const allKeys = new Set<string>([...structuralDelta.cells.keys(), ...targetTouchedKeys])
  if (allKeys.size === 0) return { cells: new Map(), fileIds: structuralDelta.fileIds }

  const keyList = [...allKeys].map((k) => {
    const [fileId, cellId] = k.split('\0')
    return { fileId: fileId!, cellId: cellId! }
  })

  // 3. For cells touched only on the structural side this window (no target
  //    delta row — e.g. cast.assign or a retime with no accompanying
  //    commit), we still need the upstream's CURRENT target state to know
  //    whether a mirror row should exist / what text it carries.
  const currentTargetState = await loadUpstreamTargetCurrentState(db, upstreamProjectId, keyList)

  // 4. Structure always comes from the upstream's current source row.
  const structure = await loadUpstreamSourceStructure(db, upstreamProjectId, keyList)

  const cells = new Map<string, FoldedCell>()
  for (const key of allKeys) {
    const [fileId, cellId] = key.split('\0') as [string, string]
    const struct = structure.get(key)
    const structuralFold = structuralDelta.cells.get(key)

    // Upstream source-side delete: tombstone regardless of target state
    // (mirrors consumes='source' delete semantics — the upstream cell is
    // gone, full stop).
    if (structuralFold?.deleted) {
      cells.set(key, {
        fileId,
        cellId,
        eventId: structuralFold.eventId,
        seq: structuralFold.seq,
        deleted: true,
        value: '',
        valueHtml: null,
        type: struct?.type ?? null,
        canonicalRef: struct?.canonicalRef ?? null,
        anchorCellId: struct?.anchorCellId ?? null,
        startMs: struct?.startMs ?? null,
        endMs: struct?.endMs ?? null,
        sequenceIndex: struct?.sequenceIndex ?? null,
        transcription: struct?.transcription ?? null,
        cameraState: struct?.cameraState ?? null,
        metadata: struct?.metadata ?? null,
      })
      continue
    }

    // Resolve the gated target text: prefer the in-window fold (has the
    // freshest validated bookkeeping); fall back to upstream's live current
    // state for cells whose commit predates this window.
    const windowState = targetDelta.get(key)
    const current = currentTargetState.get(key)

    let textEventId: string | null = null
    let textSeq: number | null = null
    let value: string | null = null
    let valueHtml: string | null = null

    if (gate === 'head') {
      if (windowState) {
        textEventId = windowState.eventId
        textSeq = windowState.seq
        value = windowState.value
        valueHtml = windowState.valueHtml
      } else if (current) {
        textEventId = current.eventId
        // Commit predates this delta window — `head` is a safe, always-
        // correct ceiling for the projection's monotonic upstream_seq guard
        // (see the `head` parameter's doc comment above).
        textSeq = head
        value = current.value
        valueHtml = current.valueHtml
      }
    } else {
      // gate='validated' (default). Only surface text when the CURRENT
      // upstream target head is validated. A draft commit over a validated
      // cell must mirror NOTHING until the new head is itself validated
      // (issue AC #2) — so we always defer to the upstream's live
      // cells.validated flag on cells.event_id, never the window fold's
      // best-effort validated guess (which can't see a validate that
      // targeted a commit from before the window).
      if (current?.validated) {
        textEventId = current.eventId
        textSeq = head
        value = current.value
        valueHtml = current.valueHtml
      }
      // If not validated, no text this cell — but structural changes (if
      // any landed this window) still need to surface once the cell has
      // been mirrored once before; a brand-new cell with no validated
      // target ever simply never gets a row (falls through below).
    }

    if (textEventId == null) {
      // No (gated) upstream target state to mirror. If there's also no
      // structural delta for this cell, skip it entirely (never existed /
      // not yet translated, §2). If there IS a structural delta but no
      // gated text, we still can't emit a mirror — source.cell.mirror's
      // payload always carries text; without a validated/head commit there
      // is nothing to seed a first row with. Skip until the first gated
      // commit lands (§2: "appear when their first gated commit lands").
      continue
    }

    // Use the later of (structural event, text event) seq as this fold's
    // "seq" for freshness-guard purposes — the monotonic upstream_seq guard
    // in the projection just needs a value that increases whenever EITHER
    // lane advances, so a later structural-only change still bumps the
    // downstream row's guard even if the text didn't move.
    const seq = Math.max(textSeq ?? 0, structuralFold?.seq ?? 0) || textSeq || 0
    const eventId = structuralFold && structuralFold.seq > (textSeq ?? -1) ? structuralFold.eventId : textEventId

    cells.set(key, {
      fileId,
      cellId,
      eventId,
      seq,
      deleted: false,
      value: value ?? '',
      valueHtml: valueHtml ?? null,
      type: struct?.type ?? null,
      canonicalRef: struct?.canonicalRef ?? null,
      anchorCellId: struct?.anchorCellId ?? null,
      startMs: struct?.startMs ?? null,
      endMs: struct?.endMs ?? null,
      sequenceIndex: struct?.sequenceIndex ?? null,
      transcription: struct?.transcription ?? null,
      cameraState: struct?.cameraState ?? null,
      metadata: struct?.metadata ?? null,
    })
  }

  return { cells, fileIds: structuralDelta.fileIds }
}

/** Existing local mirror state per cell — used for the hash-equal no-op
 *  check and to know which upstream file ids are already mirrored. */
async function loadLocalMirrorState(
  db: AquillaDb,
  downstreamProjectId: string,
  cellKeys: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, { contentHash: string | null; upstreamSeq: number | null }>> {
  const state = new Map<string, { contentHash: string | null; upstreamSeq: number | null }>()
  if (cellKeys.length === 0) return state
  const placeholders = cellKeys.map(() => '(?, ?)').join(', ')
  const binds: unknown[] = [downstreamProjectId]
  for (const k of cellKeys) binds.push(k.fileId, k.cellId)
  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, content_hash, upstream_seq FROM cells
       WHERE project_id = ? AND side = 'source' AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{ file_id: string; cell_id: string; content_hash: string | null; upstream_seq: number | string | null }>()
  for (const r of results) {
    state.set(`${r.file_id}\0${r.cell_id}`, {
      contentHash: r.content_hash,
      upstreamSeq: r.upstream_seq == null ? null : Number(r.upstream_seq),
    })
  }
  return state
}

export interface MirrorSyncResult {
  ranSync: boolean
  cellsMirrored: number
  filesMirrored: number
  fromSeq: number
  toSeq: number
  skippedHashEqual: number
}

const NOOP_RESULT: MirrorSyncResult = {
  ranSync: false,
  cellsMirrored: 0,
  filesMirrored: 0,
  fromSeq: 0,
  toSeq: 0,
  skippedHashEqual: 0,
}

/**
 * Run one mirror sync for `downstreamProjectId`. Safe to call repeatedly —
 * a no-op when not behind, resumable/idempotent when a prior run partially
 * committed. Callers are responsible for single-flighting per downstream
 * (see project-do.ts's /__link-sync endpoint) — this function does not lock
 * anything itself.
 */
export async function mirrorSync(db: AquillaDb, downstreamProjectId: string): Promise<MirrorSyncResult> {
  const link = await loadLink(db, downstreamProjectId)
  if (!link || !link.source_project_id) return NOOP_RESULT
  // Clone mode: one-time snapshot at creation, then independent forever.
  // Never runs a mirror sync (§2 — a clone must never show upstream drift).
  if (link.source_link_mode === 'clone') return NOOP_RESULT
  // NULL mode = legacy/self-contained link (pre-FRO-476 `source_project_id`
  // without link metadata) — treated as clone (no sync) until explicitly
  // re-linked with mode='live'.
  if (link.source_link_mode !== 'live') return NOOP_RESULT

  const upstreamProjectId = link.source_project_id
  const cursor = Number(link.source_link_cursor ?? 0)
  // FRO-477: consumes='target' watches an extended lane set (target commits
  // + validations on top of the always-watched structural kinds, §5); the
  // freshness probe must use the SAME lane set the delta query below uses,
  // or a target-only change would never trip `head > cursor`.
  const consumes = link.source_link_consumes === 'target' ? 'target' : 'source'
  const gate = link.source_link_gate === 'head' ? 'head' : 'validated'
  const head = await laneRelevantHeadSeq(db, upstreamProjectId, consumes)
  if (head <= cursor) return NOOP_RESULT

  const { cells: folded, fileIds: deltaFileIds } =
    consumes === 'target'
      ? await loadDeltaTargetConsumption(db, upstreamProjectId, cursor, gate, head)
      : await loadDelta(db, upstreamProjectId, cursor)

  // Which of the delta's upstream file ids are genuinely new to the
  // downstream (need a file.mirror) vs already present. The downstream
  // never stores the upstream's raw file id (files.id is a GLOBAL PK — see
  // deterministicDownstreamFileId's doc comment), so the existence check
  // compares by the DETERMINISTIC downstream id derived from each upstream
  // file id. `IN (${placeholders})` — the codebase's consistent convention
  // for id-list lookups (see readExistingEventIds/prefetchChainWinners in
  // route.ts) — rather than `= ANY(?)`, whose array-binding semantics
  // through the shim are unproven.
  const deltaFileIdList = [...deltaFileIds]
  const downstreamFileIdOf = new Map<string, string>() // upstream file id -> downstream file id
  for (const upstreamFileId of deltaFileIdList) {
    downstreamFileIdOf.set(upstreamFileId, deterministicDownstreamFileId(downstreamProjectId, upstreamFileId))
  }
  let existingDownstreamFileIdSet = new Set<string>()
  if (deltaFileIdList.length > 0) {
    const downstreamIds = deltaFileIdList.map((id) => downstreamFileIdOf.get(id)!)
    const placeholders = downstreamIds.map(() => '?').join(', ')
    const existingFiles = await db
      .prepare(`SELECT id FROM files WHERE project_id = ? AND id IN (${placeholders})`)
      .bind(downstreamProjectId, ...downstreamIds)
      .all<{ id: string }>()
    existingDownstreamFileIdSet = new Set(existingFiles.results.map((r) => r.id))
  }
  const newUpstreamFileIds = deltaFileIdList.filter(
    (upstreamFileId) => !existingDownstreamFileIdSet.has(downstreamFileIdOf.get(upstreamFileId)!),
  )

  const localState = await loadLocalMirrorState(
    db,
    downstreamProjectId,
    [...folded.values()].map((c) => ({ fileId: downstreamFileIdOf.get(c.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, c.fileId), cellId: c.cellId })),
  )

  const now = Date.now()
  const eventRows: SeqEventInsertRow[] = []
  const persistedForProjection: PersistedEvent[] = []
  let skippedHashEqual = 0

  // 1. file.mirror for new upstream files. `fileId` in the event envelope +
  // payload is the DOWNSTREAM's deterministic id, never the upstream's raw
  // id (files.id global-PK constraint — see deterministicDownstreamFileId).
  if (newUpstreamFileIds.length > 0) {
    const newFilePlaceholders = newUpstreamFileIds.map(() => '?').join(', ')
    const upstreamFiles = await db
      .prepare(`SELECT id, name, meta FROM files WHERE project_id = ? AND id IN (${newFilePlaceholders})`)
      .bind(upstreamProjectId, ...newUpstreamFileIds)
      .all<{ id: string; name: string; meta: string | null }>()
    for (const f of upstreamFiles.results) {
      const downstreamFileId = downstreamFileIdOf.get(f.id) ?? deterministicDownstreamFileId(downstreamProjectId, f.id)
      const eventId = deterministicMirrorEventId(downstreamProjectId, `file:${f.id}`)
      const payload: EventPayloads['file.mirror'] = {
        fileId: downstreamFileId,
        name: f.name,
        meta: f.meta ? (JSON.parse(f.meta) as Record<string, unknown>) : undefined,
        upstream: { projectId: upstreamProjectId, eventId: f.id, seq: head },
      }
      eventRows.push({
        id: eventId,
        schemaVersion: MIRROR_SCHEMA_VERSION,
        projectId: downstreamProjectId,
        fileId: downstreamFileId,
        cellId: null,
        parentId: null,
        kind: 'file.mirror',
        author: MIRROR_AUTHOR,
        payloadJson: JSON.stringify(payload),
        clientTs: now,
        serverTs: now,
        serverSeq: 0, // placeholder; replaced with allocated seq below
      })
      persistedForProjection.push({
        id: eventId,
        schemaVersion: MIRROR_SCHEMA_VERSION,
        projectId: downstreamProjectId,
        fileId: downstreamFileId,
        cellId: null,
        parentId: null,
        kind: 'file.mirror',
        author: MIRROR_AUTHOR,
        payload,
        clientTs: now,
        serverTs: now,
      })
    }
  }

  // 2. source.cell.mirror per folded cell — hash-equal skips entirely.
  // `fileId` on the emitted event is the DOWNSTREAM's deterministic file id
  // (same reasoning as file.mirror above); `cellId` is unchanged — cells'
  // PK includes project_id, so the same cell_id string safely appears in
  // both projects' `cells` rows.
  let cellsMirrored = 0
  for (const cell of folded.values()) {
    const downstreamFileId = downstreamFileIdOf.get(cell.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, cell.fileId)
    const key = `${downstreamFileId}\0${cell.cellId}`
    const local = localState.get(key)

    if (cell.deleted) {
      // Tombstone — always emit (idempotent via deterministic id + monotonic
      // guard); hash suppression doesn't apply to deletes.
      const eventId = deterministicMirrorEventId(downstreamProjectId, cell.eventId)
      const payload: EventPayloads['source.cell.mirror'] = {
        value: '',
        deleted: true,
        upstream: {
          projectId: upstreamProjectId,
          cellId: cell.cellId,
          eventId: cell.eventId,
          seq: cell.seq,
          side: 'source',
          contentHash: contentHash(''),
        },
      }
      pushMirrorEvent(eventRows, persistedForProjection, {
        eventId, downstreamProjectId, fileId: downstreamFileId, cellId: cell.cellId, payload, now,
      })
      cellsMirrored++
      continue
    }

    const newHash = contentHash(cell.value)
    if (local && local.contentHash === newHash) {
      // No-op suppression (§5): content unchanged (e.g. whitespace-normalized
      // re-import). upstream_event_id is allowed to lag on unchanged content
      // — §6 staleness is hash-aware, so this is harmless.
      skippedHashEqual++
      continue
    }

    const eventId = deterministicMirrorEventId(downstreamProjectId, cell.eventId)
    const payload: EventPayloads['source.cell.mirror'] = {
      value: cell.value,
      valueHtml: cell.valueHtml ?? undefined,
      type: cell.type ?? undefined,
      canonicalRef: cell.canonicalRef ?? undefined,
      anchorCellId: cell.anchorCellId,
      startMs: cell.startMs ?? undefined,
      endMs: cell.endMs ?? undefined,
      // FRO-477: only set by the consumes='target' merge fold — undefined
      // (omitted) for consumes='source', matching slice-1 payload shape
      // exactly (the projection's COALESCE-upsert treats undefined/missing
      // the same as it always has).
      sequenceIndex: cell.sequenceIndex ?? undefined,
      transcription: cell.transcription ?? undefined,
      cameraState: cell.cameraState ?? undefined,
      metadata: cell.metadata ?? undefined,
      upstream: {
        projectId: upstreamProjectId,
        cellId: cell.cellId,
        eventId: cell.eventId,
        seq: cell.seq,
        // FRO-477: 'target' when this mirror's TEXT came from the upstream's
        // target lane (consumes='target' links); 'source' otherwise. This is
        // what the inherited-staleness walk's ancestor-pin check (§6 step 2)
        // keys on to know it must side-switch to the ancestor's sibling
        // source row rather than following upstream_event_id directly.
        side: consumes === 'target' ? 'target' : 'source',
        contentHash: newHash,
      },
    }
    pushMirrorEvent(eventRows, persistedForProjection, {
      eventId, downstreamProjectId, fileId: downstreamFileId, cellId: cell.cellId, payload, now,
    })
    cellsMirrored++
  }

  const filesMirrored = newUpstreamFileIds.length
  const totalMirrors = cellsMirrored + filesMirrored

  if (totalMirrors === 0) {
    // Nothing to mirror (every changed cell hash-suppressed, no new files) —
    // advance the cursor directly, no link.cursor.advance event (§4: "no log
    // spam from unmirrored upstream noise").
    await advanceCursor(db, downstreamProjectId, head)
    return { ranSync: true, cellsMirrored: 0, filesMirrored: 0, fromSeq: cursor, toSeq: head, skippedHashEqual }
  }

  // Allocate real server_seqs for the mirror event batch and commit through
  // the front door (canonical events INSERT + buildEventProjectionStmts —
  // the same projection code the live HTTP path uses).
  const baseSeq = await allocateSeqRange(db, downstreamProjectId, eventRows.length)
  for (let i = 0; i < eventRows.length; i++) {
    eventRows[i]!.serverSeq = baseSeq + i
    persistedForProjection[i]!.serverSeq = baseSeq + i
  }

  const allStmts: AquillaStatement[] = [buildBulkEventInsertStmt(db, eventRows)]
  for (const event of persistedForProjection) {
    buildEventProjectionStmts(db, event, allStmts, { deferFileCounters: true })
  }

  // link.cursor.advance — audit record, no cells projection, emitted only
  // because the fold was non-empty.
  const cursorEventId = deterministicMirrorEventId(downstreamProjectId, `cursor:${upstreamProjectId}:${cursor}:${head}`)
  const cursorPayload: EventPayloads['link.cursor.advance'] = {
    upstreamProjectId,
    fromSeq: cursor,
    toSeq: head,
    cellCount: totalMirrors,
  }
  const cursorSeq = await allocateSeqRange(db, downstreamProjectId, 1)
  allStmts.push(
    buildBulkEventInsertStmt(db, [
      {
        id: cursorEventId,
        schemaVersion: MIRROR_SCHEMA_VERSION,
        projectId: downstreamProjectId,
        fileId: null,
        cellId: null,
        parentId: null,
        kind: 'link.cursor.advance',
        author: MIRROR_AUTHOR,
        payloadJson: JSON.stringify(cursorPayload),
        clientTs: now,
        serverTs: now,
        serverSeq: cursorSeq,
      },
    ]),
  )

  // Batch in BATCH_LIMIT-sized chunks (same convention as route.ts/rebuild.ts).
  for (let i = 0; i < allStmts.length; i += BATCH_LIMIT) {
    await db.batch(allStmts.slice(i, i + BATCH_LIMIT))
  }

  // Recompute file counters for touched files, set-based (rebuild.ts style —
  // deferFileCounters above skipped the per-event recompute). Downstream
  // file ids throughout (files.id is a global PK — see
  // deterministicDownstreamFileId's doc comment).
  const touchedFiles = new Set<string>()
  for (const c of folded.values()) {
    touchedFiles.add(downstreamFileIdOf.get(c.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, c.fileId))
  }
  for (const upstreamFileId of newUpstreamFileIds) {
    touchedFiles.add(downstreamFileIdOf.get(upstreamFileId)!)
  }
  for (const fileId of touchedFiles) {
    await db.batch([
      fileCountersRecomputeStmt(db, downstreamProjectId, fileId, now),
      ...fullProgressRecomputeStmts(db, downstreamProjectId, fileId, now),
    ])
  }

  // Cursor write: GREATEST(cursor, head) at the very end (§5) — a crashed or
  // overtaken sync can only under-claim progress, never over-claim it.
  await advanceCursor(db, downstreamProjectId, head)

  return {
    ranSync: true,
    cellsMirrored,
    filesMirrored,
    fromSeq: cursor,
    toSeq: head,
    skippedHashEqual,
  }
}

function pushMirrorEvent(
  eventRows: SeqEventInsertRow[],
  persisted: PersistedEvent[],
  args: {
    eventId: string
    downstreamProjectId: string
    fileId: string
    cellId: string
    payload: EventPayloads['source.cell.mirror']
    now: number
  },
): void {
  eventRows.push({
    id: args.eventId,
    schemaVersion: MIRROR_SCHEMA_VERSION,
    projectId: args.downstreamProjectId,
    fileId: args.fileId,
    cellId: args.cellId,
    parentId: null,
    kind: 'source.cell.mirror',
    author: MIRROR_AUTHOR,
    payloadJson: JSON.stringify(args.payload),
    clientTs: args.now,
    serverTs: args.now,
    serverSeq: 0,
  })
  persisted.push({
    id: args.eventId,
    schemaVersion: MIRROR_SCHEMA_VERSION,
    projectId: args.downstreamProjectId,
    fileId: args.fileId,
    cellId: args.cellId,
    parentId: null,
    kind: 'source.cell.mirror',
    author: MIRROR_AUTHOR,
    payload: args.payload,
    clientTs: args.now,
    serverTs: args.now,
  })
}

async function advanceCursor(db: AquillaDb, downstreamProjectId: string, head: number): Promise<void> {
  await db
    .prepare(`UPDATE projects SET source_link_cursor = GREATEST(source_link_cursor, ?) WHERE id = ?`)
    .bind(head, downstreamProjectId)
    .run()
}
