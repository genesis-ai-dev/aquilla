// File-scoped target import: populate the open file's target column from a
// USFM file, a spreadsheet (CSV/TSV/XLSX) or a subtitle file (VTT — AQU-1142;
// SRT/SBV — AQU-1144). Two match modes:
//
//   - by ref:   incoming rows carry canonical refs ("GEN 1:1") matched against
//               the file's cells (CellData.group) — same mechanism as the
//               eBible → target import (AQU-191).
//   - by order: Nth data row → Nth cell of the file. Fallback for spreadsheets
//               with no ref column, and the entry point for subtitle cues (their
//               cells carry opaque group ids, not canonical refs) — which align
//               by timecode overlap instead when both sides carry timings
//               (AQU-1143). The review screen shows the cell's source text
//               beside each incoming row so misalignment is visible before
//               anything is committed.
//
// The result shape is a structural superset of EBibleMatchResult, so
// applyEBibleTargetImport (lib/import.ts) applies the commits unchanged:
// target.cell.commit events, AD-2 parentId = targetEventId ?? sourceEventId.

import type { SourceCellRef, EBibleMatchedCell } from "./import"
import { parseUsfmLossless } from "./parsers/usfm-lossless"
import {
  parseCueRange,
  extractVttStrings,
  extractSrtStrings,
  repairShortFormCueTimestamps,
} from "./parsers/subtitle"
import { extractSbvStrings } from "./parsers/sbv"
import { frameRateScalesNear, snapToFrameRatio } from "./import/timebase"

/** Cell descriptor for file-scoped matching — SourceCellRef plus the source
 *  text, which the review table shows so the user can eyeball alignment. */
export interface FileTargetCellRef extends SourceCellRef {
  original: string
  /** Cue timing in milliseconds, for cells imported from a subtitle/timeline
   *  source (CellSummary.startTime / .endTime). Present on both sides →
   *  positional matching aligns by timecode overlap (AQU-1143). */
  startMs?: number
  endMs?: number
  /** The line's own cue timecode as the editor shows it
   *  (`00:00:10.000 --> 00:00:10.800`). The review screen prints it beside
   *  the incoming cue's timecode whenever the two differ (AQU-1360): without
   *  it a uniform shift, or a cue pulled onto a neighbouring line, reads
   *  exactly like a perfect pairing. */
  cueRef?: string
}

/** The slice of an editor cell summary the file-scoped target import reads.
 *  `CellSummary` (hooks/useActiveCellStore) satisfies it. */
export interface FileTargetCellSource {
  id: string
  fileId: string
  targetEventId?: string
  sourceEventId?: string
  translated?: string
  group?: string
  original: string
  /** The cell view's cue timecode label — empty for an untimed line
   *  (`useCells` builds it from the same start/end the fields below carry). */
  context?: string
  /** Cue timing in SECONDS — the cell view's unit (`useCells` divides the
   *  server's `start_ms` by 1000). */
  startTime?: number
  endTime?: number
}

/** One open-file cell as the matchers want it.
 *
 *  This is the seconds → milliseconds seam, and the ONLY implementation of it:
 *  the workspace reaches it through `fileTargetCellRef` (lib/import/cell-refs),
 *  so the code the tests cover is the code the dialog runs. Cell views carry
 *  cue timings in seconds while `TargetRow` timings are milliseconds; handing
 *  the seconds through unconverted put every cell within the first few ms of
 *  the file, so overlap matching (AQU-1143) found no counterpart for any cue
 *  and a subtitle target import matched 0 rows. */
export function toFileTargetCell(c: FileTargetCellSource): FileTargetCellRef {
  return {
    cellId: c.id,
    fileId: c.fileId,
    targetEventId: c.targetEventId,
    sourceEventId: c.sourceEventId,
    translated: c.translated ?? "",
    canonicalRef: c.group,
    original: c.original,
    ...(c.startTime !== undefined && c.endTime !== undefined
      ? { startMs: Math.round(c.startTime * 1000), endMs: Math.round(c.endTime * 1000) }
      : {}),
    ...(c.context ? { cueRef: c.context } : {}),
  }
}

/** The open file's cells, in display order, as the matchers want them. */
export function toFileTargetCells(summaries: readonly FileTargetCellSource[]): FileTargetCellRef[] {
  return summaries.map(toFileTargetCell)
}

/** One incoming translation row, from USFM or a mapped spreadsheet. */
export interface TargetRow {
  /** Canonical ref when the format carries one (USFM, ref-mapped sheets), or
   *  a display label such as a VTT cue's timecode range. */
  ref?: string
  text: string
  /** Cue timing in milliseconds, when the incoming format carries one. Absent
   *  timings can still be recovered from a `ref` that is a cue timecode range
   *  — see `rowTimingMs`. */
  startMs?: number
  endMs?: number
}

/** Why a pairing is left unticked for a person to check (AQU-1360). */
export type TargetMatchFlag =
  /** This row and another cue competed for one line; one of them ended up
   *  elsewhere or nowhere. Both are shown, since from timing alone either
   *  could be the one that belongs there. Wins over `sharedTiming`. */
  | "contested"
  /** Another incoming cue has exactly this time range — two people speaking
   *  at once. Timing can't tell them apart, so which line each went to rests
   *  on file order alone. */
  | "sharedTiming"

export interface FileTargetMatchedCell extends EBibleMatchedCell {
  /** The matched cell's source text — review-screen context only. */
  sourceText: string
  /** The matched line's own cue timecode, when it has one. */
  cellRef?: string
  flag?: TargetMatchFlag
  /** For a `contested` row: which contest it belongs to, numbered from 1 in
   *  the order the review list shows them. Every row, and every unmatched cue,
   *  carrying the same number fought over one line — so with several contests
   *  in one file the user can tell which rows go together. */
  contest?: number
  /** The line already holds exactly this text. Not a conflict — there is
   *  nothing to overwrite — and nothing to import either. */
  alreadyThere?: boolean
}

/** Why an incoming row found no line. Absent where the answer is structural
 *  and needs no explaining (no line carries that ref; more rows than lines). */
export type TargetOrphanReason =
  /** No line lies within reach of the cue's timing. */
  | "noLineInReach"
  /** The cue's timecode ends before it starts, so it can't be placed. That is
   *  a broken line in the partner's file, not drift — worth telling them. */
  | "backwardsTimecode"
  /** The cue lies mostly on a line another cue already holds, and lost it.
   *  Typically the second half of a line the translator split in two, whose
   *  text would otherwise be dropped without a word. */
  | "lostItsLine"

/** An incoming row that was not paired with any line. */
export interface TargetOrphan {
  ref: string
  text: string
  reason?: TargetOrphanReason
  /** For a `lostItsLine` cue: the contest it lost, matching the number on
   *  the row that holds the line. */
  contest?: number
}

/** An open-file line no incoming row covered. Listed by name (AQU-1360): a
 *  bare "5 cells not covered" in grey read exactly like a clean import. */
export interface UncoveredLine {
  cellId: string
  sourceText: string
  /** The line's own cue timecode, when it has one. */
  cellRef?: string
}

export interface FileTargetMatchResult {
  matched: FileTargetMatchedCell[]
  orphans: TargetOrphan[]
  /** Cells in the file no incoming row covered. Always `uncovered.length`. */
  unmatchedSourceCount: number
  /** Those cells, in display order. */
  uncovered: UncoveredLine[]
  /** Which policy a ref-less (positional) match actually used, so the review
   *  screen doesn't warn about raw-order alignment when it aligned by
   *  timecode. Absent for ref matching. */
  alignedBy?: "order" | "overlap"
  /** Subtitle cues the file contained that never became rows: they had no
   *  text, or a timestamp line the parser couldn't read. Set by the caller
   *  from the parse report, since the matchers only ever see the rows. */
  skippedCues?: number
  /** The correction applied to the uploaded file's timings before matching,
   *  when one was: a frame-rate stretch, a whole-file shift, or both. */
  timebase?: TimebaseAdjustment
  /** A whole-file shift that lines the file up, whether or not it was applied.
   *  The review screen offers it as a tickbox; unticking re-runs the match with
   *  `applyOffset: false`. Absent when no shift qualifies. */
  offsetCorrection?: TimebaseAdjustment
  /** Too many pairings only loosely overlap their lines — see
   *  `LOOSE_FIT_SHARE`. Set only when true. */
  looseFit?: boolean
}

function uncoveredLines(cells: FileTargetCellRef[], matched: FileTargetMatchedCell[]): UncoveredLine[] {
  const covered = new Set(matched.map((m) => m.cellId))
  return cells
    .filter((cell) => !covered.has(cell.cellId))
    .map((cell) => ({
      cellId: cell.cellId,
      sourceText: cell.original,
      ...(cell.cueRef ? { cellRef: cell.cueRef } : {}),
    }))
}

function toMatchedCell(
  cell: FileTargetCellRef,
  text: string,
  ref: string,
  flag?: TargetMatchFlag,
  /** Show the line's own timecode — only when it disagrees with the cue's. */
  showCellRef = false,
  contest?: number,
): FileTargetMatchedCell {
  const currentText = cell.translated ?? ""
  const current = currentText.trim()
  // Re-importing the text a line already holds used to count as a conflict,
  // unticked, with "Replaces:" naming the very same words (AQU-1360).
  const alreadyThere = current.length > 0 && current === text.trim()
  return {
    cellId: cell.cellId,
    fileId: cell.fileId,
    incomingText: text,
    currentText,
    hasConflict: current.length > 0 && !alreadyThere,
    parentId: cell.targetEventId ?? cell.sourceEventId ?? "",
    ref,
    sourceText: cell.original,
    ...(showCellRef && cell.cueRef ? { cellRef: cell.cueRef } : {}),
    ...(flag ? { flag } : {}),
    ...(contest !== undefined ? { contest } : {}),
    ...(alreadyThere ? { alreadyThere } : {}),
  }
}

/** Match rows to cells by canonical ref (exact, first cell wins on dup refs).
 *  Rows with empty text are ignored — a blank spreadsheet cell must never
 *  clear an existing translation. */
export function matchTargetRowsByRef(
  rows: TargetRow[],
  cells: FileTargetCellRef[],
): FileTargetMatchResult {
  const byRef = new Map<string, FileTargetCellRef>()
  for (const cell of cells) {
    if (cell.canonicalRef && !byRef.has(cell.canonicalRef)) {
      byRef.set(cell.canonicalRef, cell)
    }
  }

  const matched: FileTargetMatchedCell[] = []
  const orphans: TargetOrphan[] = []
  const matchedCellIds = new Set<string>()

  for (const row of rows) {
    if (!row.text.trim()) continue
    const cell = row.ref ? byRef.get(row.ref) : undefined
    if (!cell) {
      orphans.push({ ref: row.ref ?? "(no ref)", text: row.text })
      continue
    }
    if (matchedCellIds.has(cell.cellId)) {
      // A later row targeting an already-matched ref is an orphan, not a
      // silent overwrite of the earlier row.
      orphans.push({ ref: row.ref!, text: row.text })
      continue
    }
    matchedCellIds.add(cell.cellId)
    matched.push(toMatchedCell(cell, row.text, row.ref!))
  }

  const uncovered = uncoveredLines(cells, matched)
  return {
    matched,
    orphans,
    unmatchedSourceCount: uncovered.length,
    uncovered,
  }
}

/** How far apart two cue ranges may sit and still be considered the same cue.
 *  Only consulted when the ranges do not overlap at all: a cue shorter than
 *  the deliverables' frame-grid drift can slide clear of its counterpart, and
 *  a half-second window recovers it without ever reaching a neighbouring cue
 *  (partner subtitle cues are ~0.4s and up, separated by real gaps). */
const CUE_MATCH_TOLERANCE_MS = 500

/** Cue timing for an incoming row, in ms. Explicit `startMs`/`endMs` win; a
 *  row whose `ref` is a cue timecode range (`00:01:03.208 --> 00:01:03.667`)
 *  carries its timings there, so recover them rather than requiring every
 *  caller to restate them.
 *
 *  The single validator for row timing (AQU-1360). A range that ends before it
 *  starts is reported as `"backwards"` rather than handed on: its "overlap"
 *  with any line is arithmetic nonsense, and checking HERE — after either
 *  source — stops the label fallback from resurrecting a range the explicit
 *  fields already declared broken. It is also NOT the same as no timing: one
 *  broken cue must not knock the whole file back to matching by position. */
function rowTimingMs(row: TargetRow): Timing | "backwards" | null {
  let timing: Timing | null = null
  if (row.startMs !== undefined && row.endMs !== undefined) {
    timing = { startMs: row.startMs, endMs: row.endMs }
  } else {
    const range = row.ref ? parseCueRange(row.ref) : null
    if (range) timing = { startMs: Math.round(range.start * 1000), endMs: Math.round(range.end * 1000) }
  }
  if (!timing) return null
  return timing.endMs < timing.startMs ? "backwards" : timing
}

function cellTimingMs(cell: FileTargetCellRef): Timing | null {
  if (cell.startMs === undefined || cell.endMs === undefined) return null
  return { startMs: cell.startMs, endMs: cell.endMs }
}

/** A cue's or a line's time range, in milliseconds. */
interface Timing {
  startMs: number
  endMs: number
}

/** An incoming row that carries a usable time range. `index` is its position
 *  in the incoming file, which is the display order and the final tie-break. */
interface TimedRow {
  row: TargetRow
  index: number
  timing: Timing
}

/** An open-file line that carries a time range. `index` is its display order. */
interface TimedCell {
  cell: FileTargetCellRef
  index: number
  timing: Timing
}

interface Candidate {
  rowAt: number
  cellAt: number
  /** Milliseconds the two ranges share; 0 for a pair that only sits within tolerance. */
  overlap: number
  /** Milliseconds between two ranges that don't touch; 0 when they overlap. */
  gap: number
}

/** What the greedy overlap pass decided, kept so the review checks can ask HOW
 *  each pairing came about (AQU-1360) — who a row lost its best line to, how
 *  much overlap a pairing actually has — without running the match twice. */
interface OverlapAssignment {
  rows: TimedRow[]
  /** Start-ordered. */
  cells: TimedCell[]
  /** Every candidate pair, in the order the greedy pass considered them. */
  candidates: Candidate[]
  cellForRow: Map<number, number>
  rowForCell: Map<number, number>
  /** The overlap each assigned row won its line with (0 = a gap-only pairing). */
  overlapForRow: Map<number, number>
}

function timedCellsOf(cells: FileTargetCellRef[]): TimedCell[] {
  return cells
    .map((cell, index) => ({ cell, index, timing: cellTimingMs(cell) }))
    .filter((c): c is TimedCell => c.timing !== null)
    // Start-ordered so a row can stop scanning at the first cell that begins
    // beyond its reach. Incoming cues are NOT reliably time-ordered (real
    // partner files carry out-of-order timestamps), so each row rescans from
    // the front rather than advancing a shared pointer — quadratic in
    // principle, but on the ~500-cue episode files this exists for that is a
    // few hundred thousand integer comparisons.
    .sort((a, b) => a.timing.startMs - b.timing.startMs || a.index - b.index)
}

/** The AQU-1143 assignment: every row/line pair within tolerance becomes a
 *  candidate, ranked by overlap (largest first, then smallest gap), and taken
 *  greedily — each row and each line used at most once. */
function assignByOverlap(rows: TimedRow[], cells: TimedCell[]): OverlapAssignment {
  const candidates: Candidate[] = []

  for (let r = 0; r < rows.length; r++) {
    const timing = rows[r].timing
    for (let c = 0; c < cells.length; c++) {
      const cellTiming = cells[c].timing
      // Cells are start-sorted: once one begins after this row's reach, so
      // does every cell after it.
      if (cellTiming.startMs > timing.endMs + CUE_MATCH_TOLERANCE_MS) break
      if (cellTiming.endMs < timing.startMs - CUE_MATCH_TOLERANCE_MS) continue
      const overlap =
        Math.min(timing.endMs, cellTiming.endMs) - Math.max(timing.startMs, cellTiming.startMs)
      // Disjoint ranges have a negative "overlap" — that magnitude is the gap
      // between them, which tolerance is measured against.
      const gap = overlap < 0 ? -overlap : 0
      if (overlap <= 0 && gap > CUE_MATCH_TOLERANCE_MS) continue
      candidates.push({ rowAt: r, cellAt: c, overlap: Math.max(overlap, 0), gap })
    }
  }

  candidates.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      a.gap - b.gap ||
      // Deterministic on exact ties (identical grids): keep document order.
      rows[a.rowAt].index - rows[b.rowAt].index ||
      cells[a.cellAt].index - cells[b.cellAt].index,
  )

  const cellForRow = new Map<number, number>()
  const rowForCell = new Map<number, number>()
  const overlapForRow = new Map<number, number>()
  for (const candidate of candidates) {
    if (cellForRow.has(candidate.rowAt) || rowForCell.has(candidate.cellAt)) continue
    cellForRow.set(candidate.rowAt, candidate.cellAt)
    rowForCell.set(candidate.cellAt, candidate.rowAt)
    overlapForRow.set(candidate.rowAt, candidate.overlap)
  }

  return { rows, cells, candidates, cellForRow, rowForCell, overlapForRow }
}

const durationOf = (t: Timing): number => t.endMs - t.startMs

/** A row CLAIMS a line when their overlap is more than half the row's own
 *  length: the line is where most of the cue plays. */
function claims(overlap: number, row: Timing): boolean {
  return 2 * overlap > durationOf(row)
}

/** A CLOSE match also covers more than half the line — each is mostly the
 *  other. It is what a correct pairing looks like, and what a pairing reached
 *  only through drift or tolerance does not. */
function isCloseMatch(overlap: number, row: Timing, cell: Timing): boolean {
  return claims(overlap, row) && 2 * overlap > durationOf(cell)
}

function closeMatchedRows(a: OverlapAssignment): Set<number> {
  const close = new Set<number>()
  for (const [rowAt, cellAt] of a.cellForRow) {
    const overlap = a.overlapForRow.get(rowAt) ?? 0
    if (isCloseMatch(overlap, a.rows[rowAt].timing, a.cells[cellAt].timing)) close.add(rowAt)
  }
  return close
}

// ── Review checks (AQU-1360) ──────────────────────────────────────────────────

/**
 * Rows that competed for one line — the "contested" flag.
 *
 * It must fire ONLY when two cues genuinely fought over a line, and never on a
 * correct file (a hard product requirement). An earlier rule keyed on file
 * order false-alarmed on correct files merely listed in another order, and a
 * rule keyed on "didn't get its best-scoring line" false-alarmed on four
 * correct pairings (a 300ms shift over lines of unequal length, near-
 * simultaneous speakers, a nudged cue, a short line slid clear of its slot)
 * while missing split cues entirely. What separates the real case is that the
 * loser was left with NOTHING real, while mostly sitting on the winner's line.
 *
 * A row r is a displaced claimant when all three hold:
 *   1. r ended with no real overlap — unassigned, or paired only through the
 *      gap tolerance (overlap 0);
 *   2. r CLAIMS a line p another row w holds (overlap > half of r's length);
 *   3. if r was assigned at all, it also covers more than half of p.
 * Then w and r are both flagged; if r was left unassigned, its unmatched-list
 * entry says it lost its line instead.
 *
 * Rows that fought over one line form one contest, and contests are numbered
 * from 1 in the order the review list shows them (by the incoming position of
 * each contest's first paired row), so the screen can say which rows go
 * together. A row that turns up in two contests merges them into one.
 *
 * Exact ties can't trip it: in the identical-timing speaker case the tie loser
 * still gets a line it overlaps. And no uniform shift over non-overlapping
 * lines can: a row claiming another line by more than half of both would have
 * out-scored that line's own row. One behaviour is inherent — an EXTRA cue
 * lying mostly on a line fires, since it can't be told from a split half; it
 * is still a case where half a line would otherwise vanish without a word.
 */
interface Contests {
  assigned: Set<number>
  unassigned: Set<number>
  /** Row position → its contest's number, from 1. */
  numberOf: Map<number, number>
}

function findContested(a: OverlapAssignment): Contests {
  const assigned = new Set<number>()
  const unassigned = new Set<number>()
  // Union-find over row positions: each contest pair joins holder and claimant.
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(x, root)
    return root
  }
  const join = (x: number, y: number) => {
    for (const z of [x, y]) if (!parent.has(z)) parent.set(z, z)
    parent.set(find(x), find(y))
  }
  for (const candidate of a.candidates) {
    if (candidate.overlap <= 0) continue
    const r = candidate.rowAt
    const holder = a.rowForCell.get(candidate.cellAt)
    if (holder === undefined || holder === r) continue
    const won = a.overlapForRow.get(r) // undefined: r was left unassigned
    if (won !== undefined && won > 0) continue
    if (!claims(candidate.overlap, a.rows[r].timing)) continue
    if (won !== undefined && !(2 * candidate.overlap > durationOf(a.cells[candidate.cellAt].timing))) continue
    assigned.add(holder)
    if (won === undefined) unassigned.add(r)
    else assigned.add(r)
    join(holder, r)
  }

  // Number the contests in review-list order: by the earliest incoming
  // position among each contest's paired rows (a holder is always paired).
  const firstShown = new Map<number, number>()
  for (const at of assigned) {
    const root = find(at)
    firstShown.set(root, Math.min(firstShown.get(root) ?? Infinity, a.rows[at].index))
  }
  const numberOfRoot = new Map(
    [...firstShown].sort((x, y) => x[1] - y[1]).map(([root], i) => [root, i + 1]),
  )
  const numberOf = new Map<number, number>()
  for (const at of parent.keys()) numberOf.set(at, numberOfRoot.get(find(at))!)
  return { assigned, unassigned, numberOf }
}

/** Rows whose time range exactly equals another incoming row's. */
function sharedTimingRows(a: OverlapAssignment): Set<number> {
  const byRange = new Map<string, number[]>()
  a.rows.forEach((r, at) => {
    const key = `${r.timing.startMs}:${r.timing.endMs}`
    byRange.set(key, [...(byRange.get(key) ?? []), at])
  })
  const shared = new Set<number>()
  for (const group of byRange.values()) if (group.length > 1) group.forEach((at) => shared.add(at))
  return shared
}

/** Up to this, a cue's and its line's timings count as the same when deciding
 *  whether the review screen marks a row "Timing differs" and prints the line's
 *  own timecode. Subtitle tools snap cues to video frames (40-42ms), so a
 *  re-exported file can be off by about 20ms from rounding alone; 30ms clears
 *  that and still catches any real shift (Sam's call, 2026-09-23). */
const CELL_REF_TOLERANCE_MS = 30

/** Warn when fewer than this share of the pairings are close matches. Every
 *  correct file measured stays above 0.75; a start offset falls far below it
 *  (a 2s offset on a 650-cue episode: 640 "matched", 7 correct) and so does a
 *  file cut into different lines than the source's. */
const LOOSE_FIT_SHARE = 0.75
/** …judged only over this many pairings, so one odd cue in a tiny file can't
 *  raise it. */
const LOOSE_FIT_MIN_ROWS = 5

// ── Frame-rate rescale (AQU-1360) ─────────────────────────────────────────────
//
// A partner file authored at the wrong frame rate (25 against 23.976 is a 4.3%
// stretch) drifts past the 500ms tolerance within seconds. On a real episode
// that does NOT leave lines empty — the matcher quietly pairs cues with the
// wrong lines: on a 650-cue, 42-minute episode, 553 "matched" and 9 were right.
// So the match COUNT can't tell a good scale from a bad one; close matches can.
//
// The thresholds were set against synthetic 650-cue episodes: rescales at
// 25/23.976 gain 0.47–0.61 of the file and 1000/1001 over 42 minutes about
// 0.44; wrong scales never fit above 0.56; and every correct file already
// scores above 0.75 at scale 1, so it can never gain the 0.25 required.
//
// A whole-file SHIFT (a start offset, or a broadcast file that starts at
// 01:00:00.000) mis-pairs the same silent way, and is corrected by the same
// rules, with one more: the file suggests its own shifts (see
// `suggestOffsets`), and the best one must clearly beat the best DIFFERENT
// shift. On a regular grid, moving a file by exactly one line's spacing lines
// every cue up with its neighbour almost as well as the true shift does; that
// margin is what refuses it. A shift is offered, not imposed: the review
// screen shows it as a tickbox (Sam, 2026-09-23).

/** Too few rows and the per-quarter check means nothing. */
const RESCALE_MIN_ROWS = 20
/** A scale must line up at least this share of the file MORE than scale 1. */
const RESCALE_MIN_GAIN = 0.25
/** …and line up at least this share of the file overall. */
const RESCALE_MIN_FIT = 0.6
/** …and hold in every quarter of the file. This is what stops a START OFFSET
 *  being "fixed" with a wrong scale: an offset cancels against a scale in one
 *  part of the file only (a 2s offset scores 0.72 overall at 0.999, but 0.32
 *  in its first quarter). The offset is then found by `suggestOffsets`. */
const RESCALE_MIN_QUARTER_FIT = 0.5
/** Only ratios this close to 1 are considered — see `frameRateScalesNear`. */
const RESCALE_MAX_DEVIATION = 0.05

/** Width of the buckets the cue-to-line distances are counted in. */
const OFFSET_BUCKET_MS = 20
/** How many of the most common distances are tried, per scale. */
const OFFSET_PEAKS = 3
/** Two corrections that put the file's first and last cues within this of
 *  each other are the same correction. */
const OFFSET_SAME_MS = 250
/** A shift smaller than this is not worth offering: the matcher's own 500ms
 *  tolerance and the "Timing differs" pills already cover it. */
const OFFSET_MIN_MS = 100
/** The winning shift must line up this share of the file more than the best
 *  DIFFERENT shift — the guard against the off-by-one-line alias. */
const OFFSET_MIN_MARGIN = 0.25
/** At most this many rows are sampled when counting distances; a peak shows
 *  just as clearly in 200 cues as in 2,000, and it keeps the count cheap. */
const OFFSET_SAMPLE_ROWS = 200

/** A correction applied to the uploaded file's timings: each incoming time t
 *  becomes t × scale + offsetMs. */
export interface TimebaseAdjustment {
  /** Multiplier applied to every incoming cue time. */
  scale: number
  /** Milliseconds added after scaling. 0 for a frame-rate correction alone;
   *  negative moves the file earlier. */
  offsetMs: number
  /** The rate the file's timings behaved as if authored at, and the rate they
   *  were moved onto — null when the ratio names several pairs equally well
   *  (24/23.976 and 30/29.97 are both exactly 1001/1000). */
  fromFps: string | null
  toFps: string | null
  /** Close matches before and after the correction. */
  closeBefore: number
  closeAfter: number
}

function adjustTimedRows(rows: TimedRow[], scale: number, offsetMs = 0): TimedRow[] {
  const at = (t: number) => Math.round(t * scale + offsetMs)
  return rows.map((r) => ({ ...r, timing: { startMs: at(r.timing.startMs), endMs: at(r.timing.endMs) } }))
}

interface ScaleEvaluation {
  scale: number
  offsetMs: number
  close: number
  totalOverlap: number
  everyQuarterFits: boolean
}

function evaluateScale(rows: TimedRow[], cells: TimedCell[], scale: number, offsetMs = 0): ScaleEvaluation {
  const scaled = scale === 1 && offsetMs === 0 ? rows : adjustTimedRows(rows, scale, offsetMs)
  const assignment = assignByOverlap(scaled, cells)
  const close = closeMatchedRows(assignment)
  let totalOverlap = 0
  for (const overlap of assignment.overlapForRow.values()) totalOverlap += overlap
  const byTime = scaled
    .map((r, at) => ({ at, startMs: r.timing.startMs }))
    .sort((a, b) => a.startMs - b.startMs)
  let everyQuarterFits = true
  for (let q = 0; q < 4 && everyQuarterFits; q++) {
    const quarter = byTime.slice(
      Math.floor((q * byTime.length) / 4),
      Math.floor(((q + 1) * byTime.length) / 4),
    )
    const hits = quarter.filter((r) => close.has(r.at)).length
    if (quarter.length > 0 && hits < RESCALE_MIN_QUARTER_FIT * quarter.length) everyQuarterFits = false
  }
  return { scale, offsetMs, close: close.size, totalOverlap, everyQuarterFits }
}

/** The shifts the file itself suggests at a given scale: the most common
 *  distances from a (scaled) cue start to any line start. A file shifted by
 *  2s puts one distance, about +2000ms, far above every other; the peaks are
 *  refined to the weighted middle of their bucket and its neighbours. */
function suggestOffsets(rows: TimedRow[], cells: TimedCell[], scale: number): number[] {
  const step = Math.max(1, Math.ceil(rows.length / OFFSET_SAMPLE_ROWS))
  const buckets = new Map<number, number>()
  for (let r = 0; r < rows.length; r += step) {
    const start = rows[r].timing.startMs * scale
    for (const c of cells) {
      const b = Math.round((c.timing.startMs - start) / OFFSET_BUCKET_MS)
      buckets.set(b, (buckets.get(b) ?? 0) + 1)
    }
  }
  const peaks: number[] = []
  for (const [b] of [...buckets].sort((x, y) => y[1] - x[1] || x[0] - y[0])) {
    if (peaks.length === OFFSET_PEAKS) break
    let weight = 0
    let sum = 0
    for (const n of [b - 1, b, b + 1]) {
      const count = buckets.get(n) ?? 0
      weight += count
      sum += count * n * OFFSET_BUCKET_MS
    }
    const offset = Math.round(sum / weight)
    if (peaks.every((p) => Math.abs(p - offset) > OFFSET_SAME_MS)) peaks.push(offset)
  }
  return peaks
}

const byFit = (a: ScaleEvaluation, b: ScaleEvaluation) => b.close - a.close || b.totalOverlap - a.totalOverlap

/** The corrections that would line the file up, each null when none
 *  qualifies — or both null, leaving the file's timings exactly as delivered.
 *
 *  `rate`: a frame-rate stretch alone. It must clear every threshold above AND
 *  strictly beat every other ratio: near-duplicates (25/24 against 25/23.976)
 *  that tie on close matches are split by total overlap, and if still level
 *  nothing is applied.
 *
 *  `offset`: a whole-file shift, alone or with a stretch. Same thresholds,
 *  plus it must beat the best DIFFERENT shift by `OFFSET_MIN_MARGIN` and line
 *  up more than the stretch alone would. On an exact tie between one shift at
 *  two scales, the plain shift (scale 1) is kept. */
function chooseTimebase(
  rows: TimedRow[],
  cells: TimedCell[],
): { rate: TimebaseAdjustment | null; offset: TimebaseAdjustment | null } {
  const none = { rate: null, offset: null }
  if (rows.length < RESCALE_MIN_ROWS || cells.length === 0) return none
  const maxCloseMatches = Math.min(rows.length, cells.length)
  const base = evaluateScale(rows, cells, 1)
  // Already lined up too well to gain the required margin: nothing to try.
  if (base.close > (1 - RESCALE_MIN_GAIN) * maxCloseMatches) return none

  const qualifies = (e: ScaleEvaluation) =>
    e.close - base.close >= RESCALE_MIN_GAIN * maxCloseMatches &&
    e.close >= RESCALE_MIN_FIT * maxCloseMatches &&
    e.everyQuarterFits
  const adjustment = (e: ScaleEvaluation): TimebaseAdjustment => {
    const named = e.scale === 1 ? null : snapToFrameRatio(e.scale)
    return {
      scale: e.scale,
      offsetMs: e.offsetMs,
      fromFps: named?.cue ?? null,
      toFps: named?.reference ?? null,
      closeBefore: base.close,
      closeAfter: e.close,
    }
  }

  const scales = frameRateScalesNear(RESCALE_MAX_DEVIATION)
  const [best, runnerUp] = scales.map((scale) => evaluateScale(rows, cells, scale)).sort(byFit)
  const tied = runnerUp && runnerUp.close === best.close && runnerUp.totalOverlap === best.totalOverlap
  const rate = best && !tied && qualifies(best) ? adjustment(best) : null

  // Stable sort: scale 1 is listed first, so it wins an exact tie.
  const shifts = [1, ...scales]
    .flatMap((scale) =>
      suggestOffsets(rows, cells, scale)
        .filter((offsetMs) => Math.abs(offsetMs) >= OFFSET_MIN_MS)
        .map((offsetMs) => evaluateScale(rows, cells, scale, offsetMs)),
    )
    .sort(byFit)
  const shift = shifts[0]
  // A rival is a correction that puts the file somewhere ELSE — compared by
  // where it lands the first and last cues, not by its offset number: on a
  // short file, one hour at scale 1 and one hour plus 3.6s at 1.001 land every
  // cue in the same place, and are the same answer, not two.
  const starts = rows.map((r) => r.timing.startMs)
  const [first, last] = [Math.min(...starts), Math.max(...starts)]
  const lands = (e: ScaleEvaluation, t: number) => t * e.scale + e.offsetMs
  const sameAs = (a: ScaleEvaluation, b: ScaleEvaluation) =>
    Math.abs(lands(a, first) - lands(b, first)) <= OFFSET_SAME_MS &&
    Math.abs(lands(a, last) - lands(b, last)) <= OFFSET_SAME_MS
  const rival = shift && shifts.find((e) => !sameAs(e, shift))
  const offset =
    shift &&
    qualifies(shift) &&
    (!rival || shift.close - rival.close >= OFFSET_MIN_MARGIN * maxCloseMatches) &&
    (!rate || shift.close > rate.closeAfter)
      ? adjustment(shift)
      : null
  return { rate, offset }
}

/** Raw positional matching: data row N → file cell N. Empty rows keep their
 *  slot (so alignment holds) but produce no commit. Rows beyond the file's
 *  cell count become orphans.
 *
 *  Review-label priority: the incoming row's `ref` wins (a caller-supplied
 *  label like a VTT cue timecode is the whole point of that field), then the
 *  matched cell's canonical ref, then a bare `Row N`. Spreadsheet+order rows
 *  carry no ref, so this reduces to the previous canonicalRef-first behavior. */
function matchRowsPositionally(
  rows: TargetRow[],
  cells: FileTargetCellRef[],
): FileTargetMatchResult {
  const matched: FileTargetMatchedCell[] = []
  const orphans: TargetOrphan[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row.text.trim()) continue
    const cell = cells[i]
    if (!cell) {
      orphans.push({ ref: row.ref ?? `Row ${i + 1}`, text: row.text })
      continue
    }
    matched.push(toMatchedCell(cell, row.text, row.ref ?? cell.canonicalRef ?? `Row ${i + 1}`))
  }

  const uncovered = uncoveredLines(cells, matched)
  return {
    matched,
    orphans,
    unmatchedSourceCount: uncovered.length,
    uncovered,
    alignedBy: "order",
  }
}

/** AQU-1143 — align incoming cues to cells by best time-range overlap.
 *
 *  Raw order matching assumes the incoming file shares the source's cue grid
 *  exactly; partner deliverables for the same episode often don't, and a
 *  single inserted or deleted cue then shifts every later translation onto
 *  the wrong cell — invisible unless a reviewer eyeballs ~500 rows. Overlap
 *  matching is immune to that: each cue is placed by *when* it plays, so an
 *  edit stays local to the cue that moved.
 *
 *  Assignment is globally greedy — every candidate pair within tolerance is
 *  ranked by overlap (largest first, then smallest gap) and taken in that
 *  order, each row and cell used at most once. That is what makes an inserted
 *  extra cue fall out as an orphan rather than displacing the real
 *  translation: the true counterpart's overlap is larger, so it is assigned
 *  first and the interloper finds its cell already taken.
 *
 *  A row that reaches no cell within tolerance becomes an orphan; a cell no
 *  row reached counts as uncovered. Neither is ever a wrong-cell commit. */
export function matchTargetRowsByOverlap(
  rows: TargetRow[],
  cells: FileTargetCellRef[],
  /** `rescale`: look for a frame-rate or whole-file-shift correction before
   *  matching (AQU-1360). Off here so a direct call is pure overlap;
   *  `matchTargetRowsByOrder`, the policy entry point the dialog uses, turns it
   *  on. `applyOffset: false` leaves a qualifying shift unapplied (the review
   *  screen's tickbox) while still reporting it. */
  options: { rescale?: boolean; applyOffset?: boolean } = {},
): FileTargetMatchResult {
  // Rows carrying no text can't commit anything, and must not hold a cell
  // hostage — a blank incoming cue never clears an existing translation.
  const incoming = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.text.trim().length > 0)

  const timedRows: TimedRow[] = []
  const timedAt = new Map<number, number>() // incoming index → position in timedRows
  const backwards = new Set<number>()
  for (const { row, index } of incoming) {
    const timing = rowTimingMs(row)
    if (timing === "backwards") backwards.add(index)
    if (!timing || timing === "backwards") continue
    timedAt.set(index, timedRows.length)
    timedRows.push({ row, index, timing })
  }

  const timedCells = timedCellsOf(cells)
  // Adjusted rows keep their `row` (so their label is still the file's own
  // timecode); only the timing the matcher compares changes.
  const corrections = options.rescale ? chooseTimebase(timedRows, timedCells) : { rate: null, offset: null }
  const timebase =
    corrections.offset && options.applyOffset !== false ? corrections.offset : corrections.rate
  const assignment = assignByOverlap(
    timebase ? adjustTimedRows(timedRows, timebase.scale, timebase.offsetMs) : timedRows,
    timedCells,
  )

  const contested = findContested(assignment)
  const shared = sharedTimingRows(assignment)
  const close = closeMatchedRows(assignment)

  const matched: FileTargetMatchedCell[] = []
  const orphans: TargetOrphan[] = []

  // Emit in incoming-file order so the review list reads like the user's file.
  for (const { row, index } of incoming) {
    const at = timedAt.get(index)
    const cellAt = at === undefined ? undefined : assignment.cellForRow.get(at)
    if (at === undefined || cellAt === undefined) {
      orphans.push({
        ref: row.ref ?? `Row ${index + 1}`,
        text: row.text,
        reason: backwards.has(index)
          ? "backwardsTimecode"
          : at !== undefined && contested.unassigned.has(at)
            ? "lostItsLine"
            : "noLineInReach",
        ...(at !== undefined && contested.unassigned.has(at) ? { contest: contested.numberOf.get(at) } : {}),
      })
      continue
    }
    const { cell, timing: lineTiming } = assignment.cells[cellAt]
    const flag: TargetMatchFlag | undefined = contested.assigned.has(at)
      ? "contested"
      : shared.has(at)
        ? "sharedTiming"
        : undefined
    // Compared as numbers, on the timing the matcher used (rescaled when a
    // correction applied), so an SRT comma, a corrected frame rate, or a
    // sub-frame rounding difference never prints a second timecode.
    const cueTiming = assignment.rows[at].timing
    const drifted =
      Math.abs(cueTiming.startMs - lineTiming.startMs) > CELL_REF_TOLERANCE_MS ||
      Math.abs(cueTiming.endMs - lineTiming.endMs) > CELL_REF_TOLERANCE_MS
    // The cue's timecode is the only meaningful label a VTT row has — a
    // cue-sourced cell's `canonicalRef` is an opaque group id.
    matched.push(
      toMatchedCell(
        cell,
        row.text,
        row.ref ?? cell.canonicalRef ?? `Row ${index + 1}`,
        flag,
        drifted,
        flag === "contested" ? contested.numberOf.get(at) : undefined,
      ),
    )
  }

  const uncovered = uncoveredLines(cells, matched)
  const looseFit = matched.length >= LOOSE_FIT_MIN_ROWS && close.size < LOOSE_FIT_SHARE * matched.length
  return {
    matched,
    orphans,
    unmatchedSourceCount: uncovered.length,
    uncovered,
    alignedBy: "overlap",
    ...(timebase ? { timebase } : {}),
    ...(corrections.offset ? { offsetCorrection: corrections.offset } : {}),
    ...(looseFit ? { looseFit } : {}),
  }
}

/** Positional matching for formats that carry no canonical refs.
 *
 *  When the file's cells AND every non-empty incoming row carry cue timings,
 *  rows are aligned by timecode overlap (`matchTargetRowsByOverlap`), which
 *  survives an inserted, deleted, or shifted cue. Otherwise — no timings on
 *  either side, e.g. a spreadsheet with no ref column, or a partially timed
 *  file — it falls back to raw order, row N → cell N, exactly as before.
 *  A row whose timecode runs backwards still counts as timed here: it is
 *  reported by name as a broken cue, and must not drag every other row back
 *  to matching by position.
 *
 *  The result's `alignedBy` says which ran, so the review screen only warns
 *  about order alignment when order alignment is what happened. */
export function matchTargetRowsByOrder(
  rows: TargetRow[],
  cells: FileTargetCellRef[],
  /** `applyOffset: false` — the review screen's tickbox, unticked. */
  options: { applyOffset?: boolean } = {},
): FileTargetMatchResult {
  const nonEmptyRows = rows.filter((row) => row.text.trim().length > 0)
  const canMatchByOverlap =
    cells.length > 0 &&
    nonEmptyRows.length > 0 &&
    cells.every((cell) => cellTimingMs(cell) !== null) &&
    nonEmptyRows.every((row) => rowTimingMs(row) !== null)

  return canMatchByOverlap
    ? matchTargetRowsByOverlap(rows, cells, { rescale: true, applyOffset: options.applyOffset })
    : matchRowsPositionally(rows, cells)
}

/** Decode HTML entities commonly emitted by subtitle authoring tools
 *  (`&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and the numeric
 *  `&#160;`) so they don't show up literally in the target column.
 *  Deliberately narrow: only entities observed in real partner VTTs are
 *  decoded — the rest would risk mangling text that meant `&` literally. */
function decodeSubtitleEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
}

/** Extract target rows from a WebVTT file: one row per cue, in cue order.
 *  The cue's timestamp range becomes the row's `ref` so the review screen
 *  labels rows by timecode (never an internal UUID). Matching aligns by
 *  timecode overlap when both sides carry timings (AQU-1143), falling back
 *  to cue N → cell N otherwise — see `matchTargetRowsByOrder`. Entity-decoded
 *  so `&nbsp;` and similar don't appear literally in the imported translation. */
export function vttToTargetRows(raw: string): TargetRow[] {
  return vttToTargetRowsWithReport(raw).rows
}

/** Target rows plus what the parse could not turn into one. */
export interface TargetRowsReport {
  rows: TargetRow[]
  /** Cue blocks in the file that produced no row with text: the cue was empty,
   *  or its timestamp line was one the parser refused. They vanish from every
   *  other count, so a file whose translator left cues blank used to review
   *  as a clean run over fewer rows than it carried (AQU-1360). */
  skippedCues: number
}

/** `vttToTargetRows`, reporting the cues that never became rows. */
export function vttToTargetRowsWithReport(raw: string): TargetRowsReport {
  // Short-form timestamps are padded first. The parser demands strict
  // `HH:MM:SS.mmm`, and a cue it refuses does not arrive untimed — the payload
  // lines after the unmatched timestamp are swallowed and the cue disappears
  // with its words. Positional matching then shifts every later cue onto the
  // wrong cell, which nothing downstream can detect and nobody spots on a
  // 500-row review screen.
  const { text, cueLines } = repairShortFormCueTimestamps(raw)
  const rows: TargetRow[] = extractVttStrings(text).map((cue) => ({
    ref: cue.context,
    text: decodeSubtitleEntities(cue.original).trim(),
    // Timings ride as DATA, not only inside the label: the frame-rate rescale
    // (AQU-1360) replaces them while the label keeps showing the file's own
    // timecode, and a range the parser already holds needn't be re-read.
    ...(typeof cue.start === "number" && typeof cue.end === "number"
      ? { startMs: Math.round(cue.start * 1000), endMs: Math.round(cue.end * 1000) }
      : {}),
  }))
  return { rows, skippedCues: skippedCueCount(cueLines, rows) }
}

/** Timestamp lines that opened no row with text. Never negative: a `-->`
 *  somewhere unexpected can inflate the line count without the parser having
 *  refused anything. */
function skippedCueCount(cueLines: number, rows: TargetRow[]): number {
  return Math.max(0, cueLines - rows.filter((row) => row.text.trim().length > 0).length)
}

/** Extract target rows from a USFM file: verse bodies + heading/title/intro
 *  paratext in document order, refs and text conventions identical to the
 *  source-import path (usfmSectionToStrings in lib/import.ts) so refs match
 *  cells that were originally imported from USFM. */
export function usfmToTargetRows(
  raw: string,
  opts?: { excludeFrontMatter?: boolean },
): TargetRow[] {
  const doc = parseUsfmLossless(raw, { excludeFrontMatter: opts?.excludeFrontMatter })
  return [
    ...doc.verses.map((v) => ({ order: v.textStart, ref: v.ref, text: v.text.trim() })),
    ...doc.headings.map((h) => ({ order: h.textStart, ref: h.ref, text: h.text.trim() })),
  ]
    .sort((a, b) => a.order - b.order)
    .map(({ ref, text }) => ({ ref, text }))
}

/** Subtitle formats whose cues this module can turn into target rows. */
export const CUE_TARGET_EXTENSIONS = new Set(["srt", "sbv"])

/** Extract target rows from a subtitle file (AQU-1144).
 *
 *  Reuses the source-import cue parsers verbatim, so SRT numeric cue counters,
 *  blank-line block separators and SBV's malformed blocks are dropped exactly
 *  as they are on the source side — a cue's text is the only thing that
 *  reaches the target column.
 *
 *  Each row's `ref` is the cue's own timecode line (`00:00:01,000 -->
 *  00:00:04,000` for SRT, `0:00:01.000,0:00:02.000` for SBV), which is what
 *  the review screen labels the row with. Cue-sourced cells carry opaque uuid
 *  group ids rather than canonical refs, so rows go through
 *  matchTargetRowsByOrder — aligned by timecode overlap when the file's cells
 *  carry timings too (AQU-1143), cue N → cell N otherwise.
 *
 *  Timings are passed explicitly rather than left for `rowTimingMs` to recover
 *  from `ref`: an SBV timecode line has no `-->`, so `parseCueRange` cannot
 *  read it and SBV rows would silently fall back to raw order.
 */
export function subtitleToTargetRows(raw: string, ext: string): TargetRow[] {
  return subtitleToTargetRowsWithReport(raw, ext).rows
}

/** A timing line as each format writes it — the denominator for skipped cues. */
const SRT_TIMING_LINE = /^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s*-->/
const SBV_TIMING_LINE = /^\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}$/

/** `subtitleToTargetRows`, reporting the cues that never became rows. */
export function subtitleToTargetRowsWithReport(raw: string, ext: string): TargetRowsReport {
  const cues = ext === "sbv" ? extractSbvStrings(raw) : extractSrtStrings(raw)
  const rows: TargetRow[] = cues.map((cue) => ({
    ref: cue.context || undefined,
    text: cue.original,
    ...(cue.start !== undefined && cue.end !== undefined
      ? { startMs: Math.round(cue.start * 1000), endMs: Math.round(cue.end * 1000) }
      : {}),
  }))
  const timingLine = ext === "sbv" ? SBV_TIMING_LINE : SRT_TIMING_LINE
  const cueLines = raw.split(/\r\n|\r|\n/).filter((line) => timingLine.test(line.trim())).length
  return { rows, skippedCues: skippedCueCount(cueLines, rows) }
}
