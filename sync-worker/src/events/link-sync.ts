// AQU-476: mirror sync engine — the single propagation function every
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
//   3. Delta = upstream events in the lane set, cursor < server_seq <= head,
//      taken in bounded WINDOWS (AQU-1563: at most MIRROR_WINDOW_EVENTS
//      events / MIRROR_WINDOW_BYTES of payload each — the first sync of a new
//      link has the upstream's whole history in its delta, and holding that
//      in memory at once ran the ProjectSync DO out of its 128 MB). Steps 4–7
//      run per window, each window folded to latest-per-cell (a seq window,
//      not per-event work).
//   4. For each new upstream file: emit file.mirror.
//   5. For each folded cell: hash-equal → skip (no event, no write);
//      upstream-deleted → tombstone mirror, for a row the downstream holds
//      (AQU-1567: a cell it never held, or deletes before the run's head,
//      gets no row at all); else → content mirror.
//   6. Batch the window's mirror events through the canonical events INSERT +
//      buildEventProjectionStmts (front-door — same projection code the live
//      HTTP path uses), respecting BATCH_LIMIT. No statement on this path may
//      grow with the upstream (AQU-1543): the events INSERT and every per-cell
//      lookup are split into bounded statements.
//   7. Cursor = GREATEST(cursor, window end), written as the window's last
//      step, so an interrupted sync resumes at its last finished window; emit
//      link.cursor.advance (one per window) only when the window produced at
//      least one cell/file mirror.
//
// With a `budgetMs`, a call stops starting windows once the budget is spent
// and reports `more` — the ProjectSync DO runs each invocation that way and
// the /link/sync route calls again until the link is caught up.
//
// AQU-1560: before step 3, files a Project Lead has added to a fixed-list link
// (`projects.source_link_backfill`) are brought in whole — their upstream
// history below the cursor replayed through the same windows, restricted to
// them — and only then join the link's selection. See runBackfill.
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
import { buildBulkEventInsertStmt, buildBulkEventInsertStmts, allocateSeqRange, buildSettleSeqRangeStmt, fetchPendingFloor, type SeqEventInsertRow } from './event-insert'
import type { EventPayloads } from './types'
import { fullProgressRecomputeStmts } from './progress-projection'
import {
  parseSourceLinkBackfill,
  serializeSourceLinkBackfill,
  type SourceLinkBackfill,
} from '../../../db/shared/source-link-backfill'

const BATCH_LIMIT = 100
const MIRROR_AUTHOR = 'link-sync'
const MIRROR_SCHEMA_VERSION = 1

/**
 * AQU-1543: cell keys per `(file_id, cell_id) IN (…)` lookup — 2 bound values
 * each. Every such read in this module is keyed by the cells one sync window
 * touched, and the first sync of a new link touches the upstream's every cell,
 * so a single list grows with the upstream until postgres.js refuses the
 * statement (65,534 bound values). Bounded chunks make the number of
 * statements grow instead; 1,000 keys keeps each one small and its SQL text
 * short, the same reasoning as the import route's rows-per-INSERT.
 */
const CELL_KEY_LOOKUP_ROWS = 1000

interface CellKey {
  fileId: string
  cellId: string
}

/**
 * Run one `(file_id, cell_id) IN (…)` read over ANY number of cell keys, as a
 * series of bounded statements whose rows are concatenated.
 *
 * `sqlFor` receives the placeholder list for one chunk and returns the full
 * statement; `leadingBinds` are the values bound before the keys (the project
 * id, in every caller). Chunks cannot overlap, so no row is returned twice.
 */
async function selectByCellKeys<Row>(
  db: AquillaDb,
  cellKeys: readonly CellKey[],
  leadingBinds: readonly unknown[],
  sqlFor: (placeholders: string) => string,
): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < cellKeys.length; i += CELL_KEY_LOOKUP_ROWS) {
    const chunk = cellKeys.slice(i, i + CELL_KEY_LOOKUP_ROWS)
    const binds: unknown[] = [...leadingBinds]
    for (const k of chunk) binds.push(k.fileId, k.cellId)
    const { results } = await db
      .prepare(sqlFor(chunk.map(() => '(?, ?)').join(', ')))
      .bind(...binds)
      .all<Row>()
    for (const r of results) rows.push(r)
  }
  return rows
}

/**
 * AQU-1560: an optional `AND file_id IN (…)` restriction for the delta reads.
 *
 * Only a backfill passes one — it replays a few files' history from the start
 * of the upstream's log, and without the restriction every window of that
 * replay would read (and count against its size bound) the events of every
 * file the link already follows. The forward fold keeps reading the whole
 * lane and filters in memory, exactly as before this slice. Bounded by the
 * link request's own cap on file ids.
 */
function fileFilterSql(onlyFileIds: readonly string[] | undefined): { sql: string; binds: string[] } {
  if (!onlyFileIds) return { sql: '', binds: [] }
  return { sql: ` AND file_id IN (${onlyFileIds.map(() => '?').join(', ')})`, binds: [...onlyFileIds] }
}

/** Lane-relevant kinds for `consumes: 'source'` links (slice 1). Comments,
 *  audio attaches, back-translations, and validations never mirror — a probe
 *  that counted them would make every downstream read "behind" after any
 *  upstream noise event. */
const LANE_KINDS_SOURCE = [
  'source.cell.create',
  'source.cell.commit',
  'source.cell.delete',
  // AQU-1453: hide/show is part of the source a downstream consumes. It was
  // missing here, and the omission was the whole live half of the bug — the
  // freshness probe below reads MAX(server_seq) over THIS list, so an upstream
  // lead who only parked a cell left the downstream reading "not behind" and
  // `loadDelta` was never even called. A downstream then kept showing (and
  // counting, exporting and drafting) a verse the upstream had parked.
  'source.cell.visibility.set',
  'source.cell.mirror',
  'cell.retime',
  'cast.assign',
  'file.create',
  // AQU-1358: an upstream rename is lane-relevant. Without it the freshness
  // probe never sees the rename (head stays at the cursor, mirrorSync returns
  // NOOP) and the delta never pulls the file id in, so the downstream copy
  // keeps the old name forever.
  'file.rename',
] as const

/** AQU-477: additional lane-relevant kinds for `consumes: 'target'` links —
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

/** The two link shapes a lane set is defined for. Anything that is not
 *  'target' (including NULL on legacy rows) consumes the upstream's source. */
export type LinkConsumes = 'source' | 'target'

export function linkConsumesOf(consumes: string | null): LinkConsumes {
  return consumes === 'target' ? 'target' : 'source'
}

/** The upstream event kinds a link of this shape mirrors.
 *
 *  AQU-1545: this is the ONE definition of "an upstream change this link
 *  cares about". The freshness probe below reads it, so it decides whether a
 *  sync runs at all, and so does the push accelerator (link-notify.ts) that
 *  tells an open downstream to sync. The accelerator used to keep its own
 *  copy, and AQU-1453 / AQU-1358 added hide/show and rename here but not
 *  there, so an open downstream only saw them after a reload. */
export function laneKindsFor(consumes: string | null): readonly string[] {
  return linkConsumesOf(consumes) === 'target'
    ? [...LANE_KINDS_SOURCE, ...LANE_KINDS_TARGET_EXTRA]
    : LANE_KINDS_SOURCE
}

export interface LinkRow {
  id: string
  source_project_id: string | null
  source_link_mode: string | null
  source_link_consumes: string | null
  source_link_gate: string | null
  source_link_cursor: number
  /** AQU-1559: a JSON array of UPSTREAM file ids this link follows, or null for
   *  the whole project. Read through `linkFileIdsOf` — never raw. */
  source_link_file_ids?: string | null
  /** AQU-1560: files being added to this link, as `SourceLinkBackfill` JSON,
   *  or null when nothing is pending. Read through `parseSourceLinkBackfill`. */
  source_link_backfill?: string | null
}

export async function loadLink(db: AquillaDb, downstreamProjectId: string): Promise<LinkRow | null> {
  const link = await db
    .prepare(
      `SELECT id, source_project_id, source_link_mode, source_link_consumes,
              source_link_gate, source_link_cursor
       FROM projects WHERE id = ?`,
    )
    .bind(downstreamProjectId)
    .first<LinkRow>()
  if (!link) return null
  // AQU-1559: the followed-file selection is read in a statement of its own, and
  // a failure degrades to "follows the whole project" — the behaviour of every
  // link that predates this slice. `projects.source_link_file_ids` arrives with
  // migration 0127 and this worker is deployed independently of it being applied,
  // so selecting it above would make a database that predates the column fail
  // EVERY mirror sync, freezing links that were working. Withholding one new
  // capability is recoverable; that is not.
  try {
    const row = await db
      .prepare('SELECT source_link_file_ids FROM projects WHERE id = ?')
      .bind(downstreamProjectId)
      .first<{ source_link_file_ids: string | null }>()
    link.source_link_file_ids = row?.source_link_file_ids ?? null
  } catch {
    link.source_link_file_ids = null
  }
  // AQU-1560: same posture for the pending addition (migration 0128), in a
  // statement of its own so a database that has 0127 but not 0128 still reads
  // the selection above. Unreadable = nothing pending, which is what every link
  // that predates the column means.
  try {
    const row = await db
      .prepare('SELECT source_link_backfill FROM projects WHERE id = ?')
      .bind(downstreamProjectId)
      .first<{ source_link_backfill: string | null }>()
    link.source_link_backfill = row?.source_link_backfill ?? null
  } catch {
    link.source_link_backfill = null
  }
  return link
}

/**
 * AQU-1559: the set of upstream file ids this link follows, or `null` for a
 * whole-project link.
 *
 * `null` is the answer for every link made before this slice and for every link
 * the lead confirmed with all files checked: the fold takes the upstream's whole
 * lane delta, so a file the upstream gains later arrives here too. A set means
 * the link follows a fixed list — the fold drops everything outside it, which is
 * both how an unpicked file's edits stay upstream and how a file added upstream
 * after the link never appears here (its id cannot be in a list written before
 * it existed).
 *
 * A malformed or empty blob degrades to `null`, i.e. to the whole project: the
 * column is TEXT (migration 0127), and reading it as "follow nothing" would
 * silently freeze a live link, while reading it as "follow everything" mirrors
 * files the lead can delete. Matches auth-worker's `parseLinkFileIds`, which
 * writes it.
 */
export function linkFileIdsOf(link: Pick<LinkRow, 'source_link_file_ids'>): Set<string> | null {
  const raw = link.source_link_file_ids
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids.length > 0 ? new Set(ids) : null
}

/** Max lane-relevant upstream server_seq — the cheap freshness probe (§4).
 *  `consumes` selects the lane set: 'target' links also watch
 *  target.cell.commit / cell.validate / cell.unvalidate (§5) on top of the
 *  always-watched structural kinds. Defaults to the source-only set when
 *  omitted (backward compatible with AQU-476 call sites). */
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
  /**
   * AQU-1453: the cell's visibility as of this delta window, or `undefined`
   * when no `source.cell.visibility.set` landed in it.
   *
   * `undefined` and `false` are DIFFERENT answers and the emit loop below
   * depends on the difference: `undefined` means "this window says nothing
   * about visibility", so the mirror omits `hidden` and the downstream's own
   * `hidden_at` is left exactly as it is. `false` means the upstream showed the
   * cell again, which has to travel.
   */
  hidden?: boolean
  /** AQU-477: only populated by the consumes='target' merge fold (§2) — the
   *  consumes='source' fold leaves these undefined/null and the emit loop's
   *  payload construction omits them (matching slice-1 behavior exactly). */
  sequenceIndex?: number | null
  transcription?: string | null
  cameraState?: string | null
  metadata?: Record<string, unknown> | null
}

/**
 * AQU-1520: the `metadata` bucket off a parsed event payload, or `null`.
 *
 * The payload is `JSON.parse`d untrusted text, so anything can be sitting on
 * the key. A plain object is the only shape `cells.metadata` (JSONB) and the
 * import-envelope readers accept — an array or a scalar would project as
 * malformed JSONB and `readImportMilestone()` would reject it anyway, so it is
 * dropped here rather than mirrored downstream.
 *
 * `null` (not `undefined`) so the caller's `?? undefined` in the mirror payload
 * omits the key, which the projection's `COALESCE(excluded.metadata,
 * cells.metadata)` upsert reads as "leave the downstream row alone".
 */
function payloadMetadata(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const value = payload.metadata
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
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

/** `files.meta` as a plain object. TEXT column, so a malformed or non-object
 *  legacy blob degrades to `{}` rather than throwing mid-sync and failing the
 *  whole mirror batch over one bad row (AQU-1547). */
function parseMetaObject(meta: string | null): Record<string, unknown> {
  if (!meta) return {}
  try {
    const parsed = JSON.parse(meta) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Fold upstream lane events (sinceSeq < server_seq <= untilSeq) to
 *  latest-per-cell state, plus the set of new file ids seen. A seq window, not
 *  per-event work — and (AQU-1563) a BOUNDED one: `untilSeq` is the window end
 *  `windowEndSeq` chose, so the rows read here never grow with the upstream. */
async function loadDelta(
  db: AquillaDb,
  upstreamProjectId: string,
  sinceSeq: number,
  untilSeq: number,
  /** AQU-1560: restrict the read to these upstream files (a backfill). */
  onlyFileIds?: readonly string[],
): Promise<{ cells: Map<string, FoldedCell>; fileIds: Set<string> }> {
  const kindList = LANE_KINDS_SOURCE.map((k) => `'${k}'`).join(', ')
  const fileFilter = fileFilterSql(onlyFileIds)
  const { results } = await db
    .prepare(
      `SELECT id, file_id, cell_id, kind, payload, server_seq
       FROM events
       WHERE project_id = ? AND server_seq > ? AND server_seq <= ? AND kind IN (${kindList})${fileFilter.sql}
       ORDER BY server_seq ASC`,
    )
    .bind(upstreamProjectId, sinceSeq, untilSeq, ...fileFilter.binds)
    .all<UpstreamDeltaRow>()

  const cells = new Map<string, FoldedCell>()
  const fileIds = new Set<string>()
  /**
   * AQU-1546: the LATEST visibility this window declared per cell, tracked
   * independently of content.
   *
   * It used to be `visibilityOnly` — populated only when no content event for
   * the cell had been seen yet, and otherwise folded straight into the content
   * state. That made visibility a property of one content state rather than its
   * own dimension, and a later `source.cell.commit` replaced that state
   * wholesale: hide-then-edit ended the window with no visibility to say, so a
   * cell the upstream lead deliberately parked arrived downstream as ordinary
   * visible work. Text and visibility are independent — the last value of each
   * wins — so they are folded separately and merged after the window is read.
   */
  const visibility = new Map<
    string,
    { fileId: string; cellId: string; eventId: string; seq: number; hidden: boolean }
  >()

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

    if (
      row.kind === 'source.cell.create' ||
      // A tombstone mirror is a delete — folded with `source.cell.delete` below.
      (row.kind === 'source.cell.mirror' && payload.deleted !== true)
    ) {
      // AQU-1546: a `source.cell.mirror` is how a LINKED project records a cell
      // it received from ITS upstream, visibility included (see the payload
      // construction in the emit loop below). In a chain A → B → C, B's hidden
      // cells were never hidden by anyone in B — the state only exists on these
      // mirror events — so C's fold has to read it here or every cell A parked
      // is ordinary visible work in C. `source.cell.create` carries no
      // visibility, so the `typeof` guard leaves the importer path untouched.
      if (typeof payload.hidden === 'boolean') {
        visibility.set(key, {
          fileId: row.file_id,
          cellId: row.cell_id,
          eventId: row.id,
          seq: row.server_seq,
          hidden: payload.hidden,
        })
      }
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
        // AQU-1520: the import envelope (`metadata.aquillaImport.milestone`) is
        // what the section navigator builds its titles from. Without it a
        // mirrored file falls back to app-invented "Part N" divisions even
        // though the upstream shows "Acts Preface" and the named chapter
        // sections. It travels with the create, exactly like `type` and
        // `canonicalRef` do.
        metadata: payloadMetadata(payload),
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
        // AQU-1520: a commit payload carries text only — no import envelope —
        // so metadata rides the fold the same way `type`/`canonicalRef` do.
        // `null` when the window holds no create: the payload then omits the
        // key and the projection's COALESCE-upsert leaves the downstream row's
        // own metadata alone, rather than erasing it on every text edit.
        metadata: prev?.metadata ?? null,
      })
    } else if (row.kind === 'source.cell.visibility.set') {
      // AQU-1453: hide/show carries no text, so it can only ADJUST a state,
      // never create one. It is recorded on its own dimension here and merged
      // with whatever content the window produced, after the window is read.
      //
      // IT MUST NOT BECOME A CONTENT STATE of its own: a hide carries no
      // `value`, so a FoldedCell invented here would mirror an empty string
      // over the downstream's text — a hide that silently deletes the verse it
      // was supposed to park. When the window holds no content event for the
      // cell either, the merge below backfills the text from the upstream's
      // live row instead.
      visibility.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        hidden: payload.hidden === true,
      })
    } else if (
      row.kind === 'source.cell.delete' ||
      // AQU-1567: the chain case again. In A → B → C, B never deletes the cell
      // A deleted — B tombstones its row, and the only record of that is this
      // mirror's `deleted` flag. Folded as content it reached C as an empty
      // value on a live row: C's text blanked, and the cell counted as work.
      (row.kind === 'source.cell.mirror' && payload.deleted === true)
    ) {
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
        metadata: prev?.metadata ?? null,
      })
    }
    // cell.retime / cast.assign / file.create: structural-only kinds that
    // move the lane-relevant head but don't fold into FoldedCell content in
    // slice 1 (per spec §15 open question — "mirror metadata always, or only
    // before downstream has diverged?"). They still count toward `head` so
    // the freshness probe and cursor advance correctly; a future slice can
    // extend the fold to carry timing/cast deltas.
  }

  // AQU-1546: merge the window's visibility onto the window's content. A cell
  // whose content also moved keeps that content — the newer truth — and simply
  // gains the visibility the window declared, in whichever order the two
  // landed. When the visibility event is the LATER of the two it also becomes
  // the mirror's provenance: a fresh deterministic event id and the higher
  // `upstream_seq` that the projection's monotonic guard compares against.
  for (const [key, v] of visibility) {
    const content = cells.get(key)
    if (!content) continue
    cells.set(
      key,
      v.seq > content.seq
        ? { ...content, hidden: v.hidden, eventId: v.eventId, seq: v.seq }
        : { ...content, hidden: v.hidden },
    )
  }

  // AQU-1453: resolve the visibility-only cells against the upstream's LIVE
  // source rows. Same fallback shape as `loadUpstreamTargetCurrentState` on the
  // target path, and for the same reason: the delta window holds the change,
  // but not always the state the change applies to.
  //
  // A cell whose content DID move in this window was completed by the merge
  // just above and is skipped here — its folded text is the newer truth, and
  // re-reading the live row would only race it.
  const pending = [...visibility.values()].filter(
    (v) => !cells.has(`${v.fileId}\0${v.cellId}`),
  )
  if (pending.length > 0) {
    const liveRows = await selectByCellKeys<{
      file_id: string
      cell_id: string
      value: string | null
      value_html: string | null
      type: string | null
      canonical_ref: string | null
      anchor_cell_id: string | null
      start_ms: number | string | null
      end_ms: number | string | null
      metadata: Record<string, unknown> | null
      tombstoned_at: number | string | null
    }>(
      db,
      pending,
      [upstreamProjectId],
      (placeholders) =>
        `SELECT file_id, cell_id, value, value_html, type, canonical_ref, anchor_cell_id,
                start_ms, end_ms, metadata, tombstoned_at
           FROM cells
          WHERE project_id = ? AND side = 'source' AND target_lang = ''
            AND (file_id, cell_id) IN (${placeholders})`,
    )
    const liveByKey = new Map(liveRows.map((r) => [`${r.file_id}\0${r.cell_id}`, r]))
    for (const v of pending) {
      const key = `${v.fileId}\0${v.cellId}`
      const live = liveByKey.get(key)
      // No live row: the cell is gone upstream. A `source.cell.delete` is the
      // event that says so and tombstones on its own — mirroring a phantom
      // here would only write an empty value over the downstream's text.
      //
      // AQU-1567: a TOMBSTONED row is gone upstream too — it is how a linked
      // upstream (B in A → B → C) records a cell ITS upstream deleted, and the
      // row stays on B's screen, so B's lead can still hide or show it. Read as
      // content, that hide made the cell live again in C (a content mirror
      // clears `tombstoned_at`). The delete already travelled as its own mirror.
      if (!live || live.tombstoned_at != null) continue
      cells.set(key, {
        fileId: v.fileId,
        cellId: v.cellId,
        eventId: v.eventId,
        seq: v.seq,
        deleted: false,
        value: live.value ?? '',
        valueHtml: live.value_html,
        type: live.type,
        canonicalRef: live.canonical_ref,
        anchorCellId: live.anchor_cell_id,
        startMs: live.start_ms == null ? null : Number(live.start_ms),
        endMs: live.end_ms == null ? null : Number(live.end_ms),
        // AQU-1520: the live row is the whole state here, import envelope
        // included — a park/unpark must not strip the cell's section title.
        metadata: live.metadata,
        hidden: v.hidden,
      })
    }
  }

  return { cells, fileIds }
}

// ─────────────────────────────────────────────────────────────────────────
// AQU-477: consumes='target' — the chain case. The downstream's SOURCE lane
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
  untilSeq: number,
  /** AQU-1560: restrict the read to these upstream files (a backfill). */
  onlyFileIds?: readonly string[],
): Promise<{ states: Map<string, UpstreamTargetState>; touchedKeys: Set<string> }> {
  const fileFilter = fileFilterSql(onlyFileIds)
  const { results } = await db
    .prepare(
      `SELECT id, file_id, cell_id, kind, payload, server_seq
       FROM events
       WHERE project_id = ? AND server_seq > ? AND server_seq <= ?
         AND kind IN ('target.cell.commit', 'cell.validate', 'cell.unvalidate')${fileFilter.sql}
       ORDER BY server_seq ASC`,
    )
    .bind(upstreamProjectId, sinceSeq, untilSeq, ...fileFilter.binds)
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
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      touchedKeys.add(key)
      continue
    }

    // AQU-538 lanes: v1 target-consumption links consume the upstream's
    // DEFAULT lane only ('' / absent targetLang). A commit on a non-default
    // upstream lane is not part of the consumed stream — skip it entirely
    // (it doesn't mark the cell "touched" either: nothing about the consumed
    // lane changed). Validate/unvalidate events stay lane-blind here — a
    // validate of a non-default-lane commit falls through to the
    // current-state read, which is itself pinned to the default lane.
    if (
      row.kind === 'target.cell.commit' &&
      typeof payload.targetLang === 'string' &&
      payload.targetLang !== ''
    ) {
      continue
    }
    touchedKeys.add(key)

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
  const results = await selectByCellKeys<{ file_id: string; cell_id: string; event_id: string; value: string; value_html: string | null; validated: number | boolean }>(
    db,
    cellKeys,
    [upstreamProjectId],
    (placeholders) =>
      `SELECT file_id, cell_id, event_id, value, value_html, validated FROM cells
       WHERE project_id = ? AND side = 'target' AND target_lang = '' AND (file_id, cell_id) IN (${placeholders})`,
  )
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
  /** AQU-1567: the upstream source row is a tombstone (a chain upstream's
   *  record of a cell ITS upstream deleted). */
  tombstoned: boolean
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
    tombstoned: boolean
  }>()
  const results = await selectByCellKeys<{
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
    tombstoned_at: number | string | null
  }>(
    db,
    cellKeys,
    [upstreamProjectId],
    (placeholders) =>
      `SELECT file_id, cell_id, type, canonical_ref, anchor_cell_id, start_ms, end_ms,
              sequence_index, transcription, camera_state, metadata, tombstoned_at
       FROM cells
       WHERE project_id = ? AND side = 'source' AND (file_id, cell_id) IN (${placeholders})`,
  )
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
      tombstoned: r.tombstoned_at != null,
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
  /** The window's upper seq (AQU-1563; it was the sync's lane-relevant head
   *  before windows, and is that head for the last window). Used as the fold
   *  seq for cells whose gated text comes from loadUpstreamTargetCurrentState's
   *  fallback (commit predates the delta window) — the window end is a safe,
   *  correct monotonic ceiling for the projection's upstream_seq guard there:
   *  every earlier window ended below it and every later one starts above it. */
  untilSeq: number,
  gate: string | null,
  /** AQU-1560: restrict both lane reads to these upstream files (a backfill). */
  onlyFileIds?: readonly string[],
): Promise<{ cells: Map<string, FoldedCell>; fileIds: Set<string> }> {
  // 1. Structural-lane delta (reuses the source-consumption fold verbatim —
  //    it already extracts file ids + per-cell source-side fields/deletes).
  const structuralDelta = await loadDelta(db, upstreamProjectId, sinceSeq, untilSeq, onlyFileIds)

  // 2. Target-lane delta: which cells had a target commit or validation
  //    change in this window.
  const { states: targetDelta, touchedKeys: targetTouchedKeys } = await loadUpstreamTargetDelta(
    db,
    upstreamProjectId,
    sinceSeq,
    untilSeq,
    onlyFileIds,
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

    // AQU-1567: the upstream's source row is a tombstone — the cell was
    // deleted further up the chain, and the delete has already travelled (as
    // the branch above, in whichever window carried it). Its translation
    // stays in the upstream for review, and a new commit or validation of it
    // must not mirror as live text: a content mirror clears `tombstoned_at`
    // here, bringing back a line that is gone everywhere above.
    if (struct?.tombstoned) continue

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
        // Commit predates this delta window — the window end is a safe,
        // always-correct ceiling for the projection's monotonic upstream_seq
        // guard (see the `untilSeq` parameter's doc comment above).
        textSeq = untilSeq
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
        textSeq = untilSeq
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
      // AQU-1546: a dubbing chain is a chain of links too. The structural fold
      // is the consumes='source' fold, so it already knows what this window
      // said about the upstream cell's visibility; dropping it here was the
      // same defect as dropping it in the chain case, one lane over.
      // `undefined` (the window said nothing) still omits the key downstream.
      hidden: structuralFold?.hidden,
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

interface LocalMirrorState {
  contentHash: string | null
  upstreamSeq: number | null
  /** AQU-1453: whether the downstream row is currently parked. The hash-equal
   *  skip below compares against this, so a hide/show whose text did not change
   *  is not mistaken for upstream noise. */
  hidden: boolean
  /** AQU-1567: the upstream deleted this cell and the downstream row is a
   *  tombstone. A tombstone keeps the last text AND its content hash, so the
   *  hash-equal skip must not apply to it — an upstream restoring the cell with
   *  that same text would otherwise never clear the flag. */
  tombstoned: boolean
}

/** Existing local mirror state per cell — used for the hash-equal no-op
 *  check and to know which upstream file ids are already mirrored. */
async function loadLocalMirrorState(
  db: AquillaDb,
  downstreamProjectId: string,
  cellKeys: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, LocalMirrorState>> {
  const state = new Map<string, LocalMirrorState>()
  const results = await selectByCellKeys<{
    file_id: string
    cell_id: string
    content_hash: string | null
    upstream_seq: number | string | null
    hidden_at: number | string | null
    tombstoned_at: number | string | null
  }>(
    db,
    cellKeys,
    [downstreamProjectId],
    (placeholders) =>
      `SELECT file_id, cell_id, content_hash, upstream_seq, hidden_at, tombstoned_at FROM cells
       WHERE project_id = ? AND side = 'source' AND (file_id, cell_id) IN (${placeholders})`,
  )
  for (const r of results) {
    state.set(`${r.file_id}\0${r.cell_id}`, {
      contentHash: r.content_hash,
      upstreamSeq: r.upstream_seq == null ? null : Number(r.upstream_seq),
      hidden: r.hidden_at != null,
      tombstoned: r.tombstoned_at != null,
    })
  }
  return state
}

/**
 * AQU-1567: of `cellKeys` (UPSTREAM file ids), the cells the upstream's lane
 * log leaves deleted at `head`, reading only events after `afterSeq`.
 *
 * A downstream never gets a tombstone for a cell it did not hold — when an
 * upstream create and delete fold into one window, the delete finds no row and
 * emits nothing. Windows (AQU-1563) must not change that end state: a new
 * link's first sync replays the upstream's whole history, and a cell created
 * near the end of one window and deleted in the next would otherwise be
 * mirrored, then tombstoned — a row that exists only because of where a window
 * boundary fell. So before a window brings in a cell new to the downstream, it
 * looks ahead to the run's head.
 *
 * The answer comes from the event LOG, never the upstream's `cells` rows: the
 * log is immutable, while a projection rebuild empties `cells` and refills it,
 * and a sync that read the rows mid-rebuild would skip cells that still exist —
 * for good, since the cursor moves past their events. Only one boolean per cell
 * comes back (the existence-changing kinds, latest first), so a chain upstream's
 * large mirror payloads are never read into memory here.
 *
 * No read at all on a run's last window (`afterSeq === head`) — the only window
 * of any sync whose delta fits in one, which is nearly every sync of an
 * established link.
 */
async function deletedByHead(
  db: AquillaDb,
  upstreamProjectId: string,
  cellKeys: readonly CellKey[],
  afterSeq: number,
  head: number,
): Promise<Set<string>> {
  const gone = new Set<string>()
  if (cellKeys.length === 0 || afterSeq >= head) return gone
  const rows = await selectByCellKeys<{ file_id: string; cell_id: string; deleted: boolean }>(
    db,
    cellKeys,
    [upstreamProjectId, afterSeq, head],
    (placeholders) =>
      `SELECT DISTINCT ON (file_id, cell_id) file_id, cell_id,
              CASE kind
                WHEN 'source.cell.delete' THEN TRUE
                WHEN 'source.cell.mirror' THEN COALESCE((payload::jsonb ->> 'deleted') = 'true', FALSE)
                ELSE FALSE
              END AS deleted
         FROM events
        WHERE project_id = ? AND server_seq > ? AND server_seq <= ?
          AND kind IN ('source.cell.create', 'source.cell.delete', 'source.cell.mirror')
          AND (file_id, cell_id) IN (${placeholders})
        ORDER BY file_id, cell_id, server_seq DESC`,
  )
  for (const r of rows) if (r.deleted) gone.add(`${r.file_id}\0${r.cell_id}`)
  return gone
}

export interface MirrorSyncResult {
  ranSync: boolean
  /** Cell mirror events written, summed over the run's windows — a cell the
   *  upstream touched in two windows (created in one, hidden in a later one)
   *  is mirrored, and counted, once per window. */
  cellsMirrored: number
  filesMirrored: number
  fromSeq: number
  toSeq: number
  skippedHashEqual: number
  /** AQU-1563: windows this run folded and committed. */
  windows: number
  /** AQU-1563: the run stopped at its work budget with the link still behind
   *  `toSeq`'s upstream head — call again to continue from the saved cursor. */
  more: boolean
}

const NOOP_RESULT: MirrorSyncResult = {
  ranSync: false,
  cellsMirrored: 0,
  filesMirrored: 0,
  fromSeq: 0,
  toSeq: 0,
  skippedHashEqual: 0,
  windows: 0,
  more: false,
}

/**
 * AQU-1563: the most lane-relevant upstream events one window folds.
 *
 * The first sync of a new link has the upstream's whole history in its delta,
 * and folding it in one piece held all of it in memory at once — the raw rows,
 * the folded cells, the re-encoded mirror payloads and the driver's insert
 * buffers. A 22,838-cell / 52 MB upstream (two Biblica study-notes books) blew
 * the ProjectSync Durable Object's fixed 128 MB limit on every attempt. A
 * window is folded, written and committed, cursor included, before the next
 * one is read, so memory is bounded by the window rather than the upstream.
 */
export const MIRROR_WINDOW_EVENTS = 2000

/**
 * AQU-1563: the most upstream payload one window folds, in bytes. The event
 * count alone does not bound memory — study-notes payloads run to 20 KB each,
 * and a JS string holding any character outside Latin-1 is stored at two bytes
 * per character — so a window also ends once its payloads add up to this.
 * A window always takes at least one event, however large.
 *
 * Measured on a 52 MB, 22,838-cell upstream through the real Postgres shim,
 * under a 128 MB V8 heap: peak heap ≈ 23 MB + 10× the window's payload bytes
 * (43 MB at 2 MiB, 63 MB at 4 MiB), with the whole sync taking about 6 s
 * either way. 2 MiB keeps a Durable Object well clear of its limit.
 */
export const MIRROR_WINDOW_BYTES = 2 * 1024 * 1024

/**
 * AQU-1563: how long one ProjectSync invocation keeps starting new windows
 * before it answers `more` and leaves the rest to the next call. A Durable
 * Object request's CPU time is held to Cloudflare's 30 s default; wall time is
 * an upper bound on CPU time, and one more window can start just inside the
 * budget, so this leaves that window plenty of room.
 */
export const LINK_SYNC_INVOCATION_BUDGET_MS = 10_000

export interface MirrorSyncOptions {
  /** Lane-relevant upstream events per window (default MIRROR_WINDOW_EVENTS). */
  windowEvents?: number
  /** Upstream payload bytes per window (default MIRROR_WINDOW_BYTES). */
  windowBytes?: number
  /**
   * Stop starting new windows once this many milliseconds have passed, and
   * report `more: true`. At least one window always runs, so every call makes
   * progress. Omitted: run until the link is caught up.
   */
  budgetMs?: number
  /** Clock for the budget (tests). */
  now?: () => number
}

/**
 * Run one mirror sync for `downstreamProjectId`. Safe to call repeatedly —
 * a no-op when not behind, resumable/idempotent when a prior run partially
 * committed. Callers are responsible for single-flighting per downstream
 * (see project-do.ts's /__link-sync endpoint) — this function does not lock
 * anything itself.
 *
 * AQU-1563: the delta from the cursor to the upstream's head is folded in
 * bounded server_seq windows (see MIRROR_WINDOW_EVENTS), each committed and
 * its cursor saved before the next is read. An interrupted sync therefore
 * resumes at the last finished window, and with `budgetMs` a caller can cap
 * how much one call does and come back for the rest (`more`).
 */
export async function mirrorSync(
  db: AquillaDb,
  downstreamProjectId: string,
  opts: MirrorSyncOptions = {},
): Promise<MirrorSyncResult> {
  const link = await loadLink(db, downstreamProjectId)
  if (!link || !link.source_project_id) return NOOP_RESULT
  // Clone mode: one-time snapshot at creation, then independent forever.
  // Never runs a mirror sync (§2 — a clone must never show upstream drift).
  if (link.source_link_mode === 'clone') return NOOP_RESULT
  // NULL mode = legacy/self-contained link (pre-AQU-476 `source_project_id`
  // without link metadata) — treated as clone (no sync) until explicitly
  // re-linked with mode='live'.
  if (link.source_link_mode !== 'live') return NOOP_RESULT

  const upstreamProjectId = link.source_project_id
  const cursor = Number(link.source_link_cursor ?? 0)
  // AQU-477: consumes='target' watches an extended lane set (target commits
  // + validations on top of the always-watched structural kinds, §5); the
  // freshness probe must use the SAME lane set the delta query below uses,
  // or a target-only change would never trip `head > cursor`.
  const consumes = link.source_link_consumes === 'target' ? 'target' : 'source'
  const gate = link.source_link_gate === 'head' ? 'head' : 'validated'
  // AQU-1559: read once per sync and handed to every window — the selection is
  // a property of the link, not of a window. AQU-1560: `let`, because a
  // backfill that finishes below moves its files into it.
  let followedFileIds = linkFileIdsOf(link)
  const backfill = parseSourceLinkBackfill(link.source_link_backfill)
  let head = await laneRelevantHeadSeq(db, upstreamProjectId, consumes)
  // AQU-1005: never advance the fold cursor past an in-flight upstream
  // allocation — a late-committing upstream writer's events would otherwise be
  // permanently skipped by this link's `server_seq > cursor` fold.
  //
  // The ordering here is load-bearing: the pending floor MUST be read AFTER
  // `head` and BEFORE the delta. Read before `head` and an allocation taken in
  // between would go unfenced; read after the delta and it could already have
  // been taken against an unclamped head. Every window's upper bound is at or
  // below this clamped head (AQU-1563), so no fold ever reads past the floor.
  const upstreamFloor = await fetchPendingFloor(db, upstreamProjectId)
  if (upstreamFloor != null) head = Math.min(head, upstreamFloor)
  // AQU-1560: a pending backfill is work even when the link is not behind —
  // the files being added have their history BELOW the cursor.
  if (head <= cursor && !backfill) return NOOP_RESULT

  const windowEvents = Math.max(1, opts.windowEvents ?? MIRROR_WINDOW_EVENTS)
  const windowBytes = Math.max(1, opts.windowBytes ?? MIRROR_WINDOW_BYTES)
  const now = opts.now ?? Date.now
  const deadline = opts.budgetMs == null ? Number.POSITIVE_INFINITY : now() + opts.budgetMs

  const total: MirrorSyncResult = {
    ranSync: false,
    cellsMirrored: 0,
    filesMirrored: 0,
    fromSeq: cursor,
    toSeq: cursor,
    skippedHashEqual: 0,
    windows: 0,
    more: false,
  }
  const addWindow = (window: MirrorWindowResult): void => {
    total.ranSync = true
    total.cellsMirrored += window.cellsMirrored
    total.filesMirrored += window.filesMirrored
    total.skippedHashEqual += window.skippedHashEqual
    total.windows += 1
  }

  // AQU-1560: files a Project Lead added to this link arrive WHOLE before the
  // forward fold runs. See runBackfill.
  if (backfill) {
    const outcome = await runBackfill(db, {
      downstreamProjectId,
      upstreamProjectId,
      consumes,
      gate,
      cursor,
      head,
      followedFileIds,
      backfill,
      expectedRaw: link.source_link_backfill!,
      windowEvents,
      windowBytes,
      outOfBudget: () => total.windows > 0 && now() >= deadline,
      onWindow: addWindow,
    })
    if (outcome.status !== 'done') {
      // Out of budget, or the pending set changed under this run (a lead added
      // more files): the next call resumes from the saved state. The forward
      // fold waits — a file still being added is not in the selection yet, and
      // the forward fold could not bring it in anyway.
      total.ranSync = true
      total.more = true
      return total
    }
    followedFileIds = outcome.followedFileIds
    total.ranSync = true
  }
  if (head <= cursor) return total

  total.ranSync = true
  let sinceSeq = cursor
  while (sinceSeq < head) {
    if (total.windows > 0 && now() >= deadline) {
      total.more = true
      break
    }
    const untilSeq = await windowEndSeq(db, upstreamProjectId, consumes, sinceSeq, head, windowEvents, windowBytes)
    const window = await mirrorWindow(db, {
      downstreamProjectId,
      upstreamProjectId,
      consumes,
      gate,
      fileFilter: followedFileIds,
      sinceSeq,
      untilSeq,
      head,
    })
    addWindow(window)
    total.toSeq = untilSeq
    sinceSeq = untilSeq
  }
  return total
}

interface RunBackfillArgs {
  downstreamProjectId: string
  upstreamProjectId: string
  consumes: LinkConsumes
  gate: 'head' | 'validated'
  /** The link's cursor: where the replay ends and the forward fold begins. */
  cursor: number
  /** The run's fenced lane-relevant head, for `deletedByHead`'s lookahead. */
  head: number
  /** The link's selection before the files join it (null = whole project). */
  followedFileIds: Set<string> | null
  backfill: SourceLinkBackfill
  /** `source_link_backfill` exactly as read — every write compares against it. */
  expectedRaw: string
  windowEvents: number
  windowBytes: number
  outOfBudget: () => boolean
  onWindow: (window: MirrorWindowResult) => void
}

type RunBackfillOutcome =
  | { status: 'done'; followedFileIds: Set<string> | null }
  | { status: 'more' }

/**
 * AQU-1560: bring the files a Project Lead added to an existing link in WHOLE.
 *
 * The link's cursor is already past most of their history — the fold read it
 * and dropped it, because the files were not followed then — so they cannot
 * arrive from the cursor onward. Their upstream history is replayed instead,
 * from where the replay last got to (`doneSeq`, 0 at first) up to the cursor,
 * through the same windowed fold a new link's first sync uses, restricted to
 * those files. What arrives is therefore exactly what the first sync would have
 * brought: every cell, hidden ones hidden, section titles included, and nothing
 * for cells the upstream created and later deleted.
 *
 * The files only join the link once the replay reaches the cursor: one
 * compare-and-set statement moves them into `source_link_file_ids` (or clears
 * it, when the link now follows every upstream file — AQU-1559's rule) and
 * clears the pending column. Until then they are not part of the link, so the
 * forward fold neither brings them in nor needs to, and every write here
 * compares against the column as this run read it — a lead adding more files
 * mid-replay, or a re-link, makes this run stop and the next one start from
 * the new state.
 *
 * No window here moves the link's cursor — the replay is entirely below it.
 * Its progress is `doneSeq`, saved after every window, so an interrupted replay
 * resumes. And no file appears half-filled: each file's row (`file.mirror`) is
 * held back until the replay's last window, so a replay that stops part-way
 * leaves no new file in the project's file list. Its cells may already be in
 * place, attached to no file row and so on no screen, until a later run
 * finishes the job.
 *
 * Single-flighted like every mirror sync (the downstream's ProjectSync DO), so
 * no forward fold can move the cursor while a replay is chasing it.
 */
async function runBackfill(db: AquillaDb, args: RunBackfillArgs): Promise<RunBackfillOutcome> {
  const { downstreamProjectId, upstreamProjectId, cursor, backfill } = args
  const fileIds = backfill.fileIds
  const fileFilter = new Set(fileIds)
  let raw = args.expectedRaw
  let doneSeq = backfill.doneSeq
  while (doneSeq < cursor) {
    if (args.outOfBudget()) return { status: 'more' }
    const untilSeq = await windowEndSeq(
      db, upstreamProjectId, args.consumes, doneSeq, cursor, args.windowEvents, args.windowBytes, fileIds,
    )
    const window = await mirrorWindow(db, {
      downstreamProjectId,
      upstreamProjectId,
      consumes: args.consumes,
      gate: args.gate,
      fileFilter,
      sinceSeq: doneSeq,
      untilSeq,
      head: args.head,
      backfill: { fileIds, final: untilSeq >= cursor },
    })
    args.onWindow(window)
    const next = serializeSourceLinkBackfill({ fileIds, doneSeq: untilSeq })
    const saved = await db
      .prepare(`UPDATE projects SET source_link_backfill = ? WHERE id = ? AND source_link_backfill = ?`)
      .bind(next, downstreamProjectId, raw)
      .run()
    if (Number(saved.meta?.changes ?? 0) === 0) return { status: 'more' }
    raw = next
    doneSeq = untilSeq
  }

  // AQU-1559's rule for the result: following every file the upstream has now
  // IS the whole-project link, which also takes in the files it gains later.
  let followed: Set<string> | null = null
  if (args.followedFileIds) {
    followed = new Set([...args.followedFileIds, ...fileIds])
    const { results } = await db
      .prepare(`SELECT id FROM files WHERE project_id = ? AND deleted_at IS NULL`)
      .bind(upstreamProjectId)
      .all<{ id: string }>()
    if (results.every((f) => followed!.has(f.id))) followed = null
  }
  const done = await db
    .prepare(
      `UPDATE projects
          SET source_link_file_ids = ?, source_link_backfill = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND source_link_backfill = ?`,
    )
    .bind(followed ? JSON.stringify([...followed]) : null, downstreamProjectId, raw)
    .run()
  if (Number(done.meta?.changes ?? 0) === 0) return { status: 'more' }
  return { status: 'done', followedFileIds: followed }
}

/**
 * AQU-1563: the upper server_seq of the next window after `sinceSeq` — the
 * furthest lane-relevant upstream event that keeps the window within
 * `maxEvents` events and `maxBytes` of payload, and never fewer than one
 * event. A window that takes every remaining lane event ends AT `head`, so the
 * cursor lands where the next freshness probe compares.
 *
 * Only `server_seq` and the payload's length are read here; the payloads
 * themselves are read by the window's fold, inside this bound.
 */
async function windowEndSeq(
  db: AquillaDb,
  upstreamProjectId: string,
  consumes: LinkConsumes,
  sinceSeq: number,
  head: number,
  maxEvents: number,
  maxBytes: number,
  /** AQU-1560: count only these upstream files' events (a backfill). */
  onlyFileIds?: readonly string[],
): Promise<number> {
  const kindList = laneKindsFor(consumes).map((k) => `'${k}'`).join(', ')
  const fileFilter = fileFilterSql(onlyFileIds)
  const row = await db
    .prepare(
      `SELECT server_seq, rn, taken
         FROM (
           SELECT server_seq,
                  SUM(len) OVER (ORDER BY server_seq) AS running_bytes,
                  ROW_NUMBER() OVER (ORDER BY server_seq) AS rn,
                  COUNT(*) OVER () AS taken
             FROM (
               SELECT server_seq, octet_length(payload) AS len
                 FROM events
                WHERE project_id = ? AND server_seq > ? AND server_seq <= ? AND kind IN (${kindList})${fileFilter.sql}
                ORDER BY server_seq
                LIMIT ?
             ) next_events
         ) sized
        WHERE rn = 1 OR running_bytes <= ?
        ORDER BY server_seq DESC
        LIMIT 1`,
    )
    .bind(upstreamProjectId, sinceSeq, head, ...fileFilter.binds, maxEvents, maxBytes)
    .first<{ server_seq: number | string; rn: number | string; taken: number | string }>()
  if (!row) return head
  // Fewer events remained than one window holds, and they all fit: this window
  // is the last one, so it runs to the head.
  if (Number(row.rn) === Number(row.taken) && Number(row.taken) < maxEvents) return head
  return Number(row.server_seq)
}

interface MirrorWindowArgs {
  downstreamProjectId: string
  upstreamProjectId: string
  consumes: LinkConsumes
  gate: 'head' | 'validated'
  /** The upstream file ids this window may fold, or null for all of them.
   *  Forward windows pass the link's selection (AQU-1559, `linkFileIdsOf`);
   *  backfill windows pass the files being added (AQU-1560). */
  fileFilter: Set<string> | null
  /** AQU-1560: set on a backfill window — a replay, below the cursor, of the
   *  history of files being added to the link. See runBackfill. */
  backfill?: {
    fileIds: readonly string[]
    /** The replay's last window: it reaches the cursor. */
    final: boolean
  }
  /** Exclusive lower bound: the link's cursor when the window starts. */
  sinceSeq: number
  /** Inclusive upper bound: where the cursor stands once the window commits. */
  untilSeq: number
  /** The run's (fenced) lane-relevant upstream head — where the last window
   *  ends. Read past `untilSeq` only by `deletedByHead`. */
  head: number
}

interface MirrorWindowResult {
  cellsMirrored: number
  filesMirrored: number
  skippedHashEqual: number
}

/**
 * Fold, write and commit one window of upstream lane events
 * (`sinceSeq < server_seq <= untilSeq`), then advance the link cursor to
 * `untilSeq`. Everything this holds in memory is bounded by the window.
 */
async function mirrorWindow(db: AquillaDb, args: MirrorWindowArgs): Promise<MirrorWindowResult> {
  const { downstreamProjectId, upstreamProjectId, consumes, gate, fileFilter, backfill, sinceSeq, untilSeq, head } = args
  const onlyFileIds = backfill?.fileIds
  const { cells: folded, fileIds: deltaFileIds } =
    consumes === 'target'
      ? await loadDeltaTargetConsumption(db, upstreamProjectId, sinceSeq, untilSeq, gate, onlyFileIds)
      : await loadDelta(db, upstreamProjectId, sinceSeq, untilSeq, onlyFileIds)

  // AQU-1559: a link that follows a fixed list of upstream files drops the rest
  // of the delta here, at the single point both folds converge, so neither the
  // file.mirror pass nor the cell pass below can see an unfollowed file. The
  // cursor still advances to `head` at the end, which is what makes an upstream
  // edit to an unpicked file a true no-op rather than a change that keeps being
  // re-folded: the fold yields nothing, so no mirror event and no
  // link.cursor.advance is emitted and nothing shows in "Upstream changes".
  if (fileFilter) {
    for (const fileId of [...deltaFileIds]) {
      if (!fileFilter.has(fileId)) deltaFileIds.delete(fileId)
    }
    for (const [key, cell] of [...folded]) {
      if (!fileFilter.has(cell.fileId)) folded.delete(key)
    }
  }
  // AQU-1560: the replay's last window is where every file being added gets its
  // row, whether or not this window's events touch it — the earlier windows
  // held the rows back (below), so a file whose events all fell in those
  // windows would otherwise never get one.
  if (backfill?.final) {
    for (const fileId of backfill.fileIds) deltaFileIds.add(fileId)
  }

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
  // AQU-1358: the downstream's CURRENT name comes back alongside the id, so a
  // file the delta already knows can be classified three ways rather than two:
  // new (mirror it), renamed upstream (re-mirror to refresh the name), or
  // unchanged (emit nothing — this is what keeps a re-sync idempotent and
  // stops repeated syncs minting duplicate rows/events for files A and B when
  // only file C is new).
  let existingDownstreamFileIdSet = new Set<string>()
  const downstreamNameOf = new Map<string, string>() // downstream file id -> its current name
  if (deltaFileIdList.length > 0) {
    const downstreamIds = deltaFileIdList.map((id) => downstreamFileIdOf.get(id)!)
    const placeholders = downstreamIds.map(() => '?').join(', ')
    const existingFiles = await db
      .prepare(`SELECT id, name FROM files WHERE project_id = ? AND id IN (${placeholders})`)
      .bind(downstreamProjectId, ...downstreamIds)
      .all<{ id: string; name: string }>()
    existingDownstreamFileIdSet = new Set(existingFiles.results.map((r) => r.id))
    for (const r of existingFiles.results) downstreamNameOf.set(r.id, r.name)
  }
  // AQU-1560: a backfill window before the replay's last holds back the rows of
  // files new to this project, so an add that stops part-way never leaves a
  // half-filled file in the file list. Their cells still land (no foreign key
  // ties `cells` to `files`); the last window brings the rows.
  const holdNewFiles = backfill != null && !backfill.final
  const newUpstreamFileIds = holdNewFiles
    ? []
    : deltaFileIdList.filter(
        (upstreamFileId) => !existingDownstreamFileIdSet.has(downstreamFileIdOf.get(upstreamFileId)!),
      )

  const localState = await loadLocalMirrorState(
    db,
    downstreamProjectId,
    [...folded.values()].map((c) => ({ fileId: downstreamFileIdOf.get(c.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, c.fileId), cellId: c.cellId })),
  )

  // AQU-1567: cells this window would bring in for the first time but that a
  // LATER window of the same run deletes. See deletedByHead.
  const goneByHead = await deletedByHead(
    db,
    upstreamProjectId,
    [...folded.values()].filter((c) => {
      if (c.deleted) return false
      const downstreamFileId = downstreamFileIdOf.get(c.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, c.fileId)
      return !localState.has(`${downstreamFileId}\0${c.cellId}`)
    }),
    untilSeq,
    head,
  )

  const now = Date.now()
  const eventRows: SeqEventInsertRow[] = []
  const persistedForProjection: PersistedEvent[] = []
  let skippedHashEqual = 0

  // 1. file.mirror for new upstream files, and (AQU-1358) for already-mirrored
  // files whose upstream name has since changed — file.mirror's projection is
  // an idempotent upsert that refreshes `name` on conflict, so a rename needs
  // no new event kind, only an event that is actually emitted. `fileId` in the
  // event envelope + payload is the DOWNSTREAM's deterministic id, never the
  // upstream's raw id (files.id global-PK constraint — see
  // deterministicDownstreamFileId).
  const renamedUpstreamFileIds: string[] = []
  // AQU-1560: counted as emitted rather than derived from the id lists — the
  // replay's last window adds every file being added to the list, including
  // one the upstream no longer has a row for, which gets no event.
  let fileMirrorsEmitted = 0
  if (deltaFileIdList.length > 0) {
    const filePlaceholders = deltaFileIdList.map(() => '?').join(', ')
    const upstreamFiles = await db
      .prepare(`SELECT id, name, meta FROM files WHERE project_id = ? AND id IN (${filePlaceholders})`)
      .bind(upstreamProjectId, ...deltaFileIdList)
      .all<{ id: string; name: string; meta: string | null }>()
    for (const f of upstreamFiles.results) {
      const downstreamFileId = downstreamFileIdOf.get(f.id) ?? deterministicDownstreamFileId(downstreamProjectId, f.id)
      const isNew = !existingDownstreamFileIdSet.has(downstreamFileId)
      if (isNew && holdNewFiles) continue
      const renamed = !isNew && downstreamNameOf.get(downstreamFileId) !== f.name
      // Already mirrored under the same name — nothing to say. Most delta
      // files land here (they were only dragged in by their cells' events),
      // and skipping them is what makes repeated syncs a no-op instead of a
      // fresh copy.
      if (!isNew && !renamed) continue
      if (renamed) renamedUpstreamFileIds.push(f.id)
      // Key a rename on the NEW NAME so each distinct rename gets its own
      // event-log row. (The projection runs regardless — it is built from
      // persistedForProjection unconditionally, while only the events INSERT
      // dedupes on the PK — so reusing `file:<id>` would still land the name;
      // it would just drop the audit row.) Keeping it deterministic means a
      // replay of the same rename is still an exact id-replay, and keeping it
      // distinct from `file:<id>` leaves the create-time id every existing
      // downstream already carries untouched.
      const eventId = deterministicMirrorEventId(
        downstreamProjectId,
        renamed ? `file:${f.id}:name:${contentHash(f.name)}` : `file:${f.id}`,
      )
      // AQU-1547: stamp which upstream file this row mirrors. The upstream's
      // own meta is passed through verbatim (language/orderedBy etc.), which
      // left mirrored rows with no record of their provenance — so a later
      // detach snapshot could only find "the project's copy" by display name,
      // and a name cannot tell a mirrored copy from a file the project
      // imported itself. `upstreamFileId` is written LAST so an inherited
      // value (the upstream itself being a clone) cannot shadow the real one.
      // Matches the key auth-worker's `withUpstreamFileId` writes on clone
      // copies; auth-worker's `deterministicDownstreamFileId` still covers
      // rows mirrored before this stamp existed.
      const upstreamMeta = parseMetaObject(f.meta)
      const payload: EventPayloads['file.mirror'] = {
        fileId: downstreamFileId,
        name: f.name,
        meta: { ...upstreamMeta, upstreamFileId: f.id },
        upstream: { projectId: upstreamProjectId, eventId: f.id, seq: untilSeq },
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
      fileMirrorsEmitted++
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
      // AQU-1567: a tombstone marks a row the downstream HOLDS. With no row
      // there is nothing to mark — the upstream created and deleted the cell
      // before this downstream ever mirrored it (in one window, or across two
      // via deletedByHead: on a new link's first sync, that is every cell the
      // upstream ever deleted).
      // Emitting anyway inserted an empty, typeless, anchorless source row that
      // the editor shows as a blank line at the edge of the file. A row that is
      // already a tombstone needs nothing either. Neither skip loses anything:
      // a later re-create of the id is a content mirror, which inserts or
      // restores the row on its own.
      if (!local || local.tombstoned) continue
      // Otherwise always emit (idempotent via deterministic id + monotonic
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

    // AQU-1567: new to the downstream, and deleted again before the run's head
    // — the later window's delete will find no row and skip, so the end state
    // is no row at all, exactly as when the create and the delete share one
    // window. Mirroring it here would leave a tombstone that only exists
    // because of where a window boundary fell.
    if (!local && goneByHead.has(`${cell.fileId}\0${cell.cellId}`)) continue

    const newHash = contentHash(cell.value)
    // AQU-1453: a hide or a show moves no text, so the hash is equal by
    // definition — suppressing on the hash alone is exactly how the visibility
    // change got dropped even once the event became lane-relevant. The skip now
    // needs BOTH to be unchanged. `undefined` means this window said nothing
    // about visibility, which is "unchanged" and leaves the old rule intact.
    const visibilityUnchanged =
      cell.hidden === undefined || cell.hidden === (local?.hidden ?? false)
    if (local && !local.tombstoned && local.contentHash === newHash && visibilityUnchanged) {
      // No-op suppression (§5): content unchanged (e.g. whitespace-normalized
      // re-import). upstream_event_id is allowed to lag on unchanged content
      // — §6 staleness is hash-aware, so this is harmless. Never for a
      // tombstone (AQU-1567): its hash is the deleted text's, so a restore
      // carrying that text is a change, and only this mirror clears the flag.
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
      // AQU-1453: omitted unless this window changed the cell's visibility, so
      // a mirror that is only about text leaves the downstream's `hidden_at`
      // untouched rather than un-parking a cell as a side effect.
      hidden: cell.hidden,
      // AQU-477: only set by the consumes='target' merge fold — undefined
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
        // AQU-477: 'target' when this mirror's TEXT came from the upstream's
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

  // AQU-1358: renamed files are mirrored too (name refresh), so they count —
  // otherwise a rename-only delta folds to totalMirrors === 0 and the whole
  // emit is discarded as an empty fold below.
  const filesMirrored = fileMirrorsEmitted
  const totalMirrors = cellsMirrored + filesMirrored

  if (totalMirrors === 0) {
    // Nothing to mirror (every changed cell hash-suppressed, no new files) —
    // advance the cursor directly, no link.cursor.advance event (§4: "no log
    // spam from unmirrored upstream noise"). AQU-1560: a backfill window is
    // below the cursor and never moves it; runBackfill saves its progress.
    if (!backfill) await advanceCursor(db, downstreamProjectId, untilSeq)
    return { cellsMirrored: 0, filesMirrored: 0, skippedHashEqual }
  }

  // Allocate real server_seqs for the mirror event batch and commit through
  // the front door (canonical events INSERT + buildEventProjectionStmts —
  // the same projection code the live HTTP path uses).
  const baseSeq = await allocateSeqRange(db, downstreamProjectId, eventRows.length)
  for (let i = 0; i < eventRows.length; i++) {
    eventRows[i].serverSeq = baseSeq + i
    persistedForProjection[i].serverSeq = baseSeq + i
  }

  // AQU-1543: one mirror event per file and cell in the window. A single
  // INSERT for all of them is what failed every sync of an upstream past ~5,460
  // cells (back when the first sync was one window holding the upstream's whole
  // history), so the rows go out in bounded statements — same rows, same order,
  // same `ON CONFLICT (id) DO NOTHING` replay safety. A window still holds more
  // events than one statement carries.
  const allStmts: AquillaStatement[] = buildBulkEventInsertStmts(db, eventRows)
  for (const event of persistedForProjection) {
    buildEventProjectionStmts(db, event, allStmts, { deferFileCounters: true })
  }

  // link.cursor.advance — audit record, no cells projection, emitted only
  // because the fold was non-empty. It also closes the batch "Upstream
  // changes" groups these mirror events into (link-cursor-batches-route.ts
  // reads batches as the seq runs between these records), so a backfill window
  // writes one too (AQU-1560) — under its own id: its upstream seq range is
  // one a forward window already covered, and a shared id would silently drop
  // it as a duplicate and fold its events into the next forward batch.
  const cursorEventId = deterministicMirrorEventId(
    downstreamProjectId,
    backfill
      ? `backfill:${upstreamProjectId}:${contentHash([...backfill.fileIds].sort().join('\0'))}:${sinceSeq}:${untilSeq}`
      : `cursor:${upstreamProjectId}:${sinceSeq}:${untilSeq}`,
  )
  const cursorPayload: EventPayloads['link.cursor.advance'] = {
    upstreamProjectId,
    fromSeq: sinceSeq,
    toSeq: untilSeq,
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
  allStmts.push(
    buildSettleSeqRangeStmt(db, downstreamProjectId, baseSeq),
    buildSettleSeqRangeStmt(db, downstreamProjectId, cursorSeq),
  )

  // Batch in BATCH_LIMIT-sized chunks (same convention as route.ts/rebuild.ts).
  for (let i = 0; i < allStmts.length; i += BATCH_LIMIT) {
    await runMirrorBatch(db, allStmts.slice(i, i + BATCH_LIMIT))
  }

  // Recompute file counters for touched files, set-based (rebuild.ts style —
  // deferFileCounters above skipped the per-event recompute). Downstream
  // file ids throughout (files.id is a global PK — see
  // deterministicDownstreamFileId's doc comment).
  const touchedFiles = new Set<string>()
  for (const c of folded.values()) {
    const downstreamFileId = downstreamFileIdOf.get(c.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, c.fileId)
    // AQU-1560: a file whose row is held back has no counters to recompute
    // yet; the replay's last window recomputes it along with its new row.
    if (holdNewFiles && !existingDownstreamFileIdSet.has(downstreamFileId)) continue
    touchedFiles.add(downstreamFileId)
  }
  for (const upstreamFileId of [...newUpstreamFileIds, ...renamedUpstreamFileIds]) {
    touchedFiles.add(downstreamFileIdOf.get(upstreamFileId)!)
  }
  for (const fileId of touchedFiles) {
    await db.batch([
      fileCountersRecomputeStmt(db, downstreamProjectId, fileId, now),
      ...fullProgressRecomputeStmts(db, downstreamProjectId, fileId, now),
    ])
  }

  // Cursor write: GREATEST(cursor, untilSeq) at the very end of the window
  // (§5) — a crashed or overtaken window can only under-claim progress, never
  // over-claim it, and (AQU-1563) every window before it stays claimed.
  // AQU-1560: not for a backfill window, which is below the cursor.
  if (!backfill) await advanceCursor(db, downstreamProjectId, untilSeq)

  return { cellsMirrored, filesMirrored, skippedHashEqual }
}

/**
 * One atomic batch of mirror statements, pipelined where the executor can.
 *
 * AQU-1543: a sync writes one projection statement per mirrored cell, so a
 * large upstream means thousands of them. `batch()` awaits them one at a time,
 * a round trip or two each — the shim documents ~21 statements/s for that
 * through Hyperdrive (see `batchPipelined` in db/shim/postgres.ts), at which
 * rate a New Testament's worth of cells outlasts PENDING_ALLOC_TTL_MS, the
 * bound every write batch is meant to finish inside. `batchPipelined` keeps
 * the order and the all-or-nothing transaction of `batch()` and sends each
 * batch in a handful of round trips; the import and migration writers make
 * the same choice for the same reason. Executors without it (test doubles)
 * fall back to `batch()`.
 */
async function runMirrorBatch(db: AquillaDb, stmts: AquillaStatement[]): Promise<void> {
  if (db.batchPipelined) {
    await db.batchPipelined(stmts)
    return
  }
  await db.batch(stmts)
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
