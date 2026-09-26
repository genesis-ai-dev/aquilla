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

/** Cell descriptor for file-scoped matching — SourceCellRef plus the source
 *  text, which the review table shows so the user can eyeball alignment. */
export interface FileTargetCellRef extends SourceCellRef {
  original: string
  /** Cue timing in milliseconds, for cells imported from a subtitle/timeline
   *  source (CellSummary.startTime / .endTime). Present on both sides →
   *  positional matching aligns by timecode overlap (AQU-1143). */
  startMs?: number
  endMs?: number
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
  /** Cue timing in SECONDS — the cell view's unit (`useCells` divides the
   *  server's `start_ms` by 1000). */
  startTime?: number
  endTime?: number
}

/** The open file's cells, in display order, as the matchers want them.
 *
 *  This is the seconds → milliseconds seam. Cell views carry cue timings in
 *  seconds while `TargetRow` timings are milliseconds; handing the seconds
 *  through unconverted put every cell within the first few ms of the file, so
 *  overlap matching (AQU-1143) found no counterpart for any cue and a subtitle
 *  target import matched 0 rows. */
export function toFileTargetCells(summaries: readonly FileTargetCellSource[]): FileTargetCellRef[] {
  return summaries.map((c) => ({
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
  }))
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

export interface FileTargetMatchedCell extends EBibleMatchedCell {
  /** The matched cell's source text — review-screen context only. */
  sourceText: string
}

export interface FileTargetMatchResult {
  matched: FileTargetMatchedCell[]
  orphans: { ref: string; text: string }[]
  /** Cells in the file no incoming row covered. */
  unmatchedSourceCount: number
  /** Which policy a ref-less (positional) match actually used, so the review
   *  screen doesn't warn about raw-order alignment when it aligned by
   *  timecode. Absent for ref matching. */
  alignedBy?: "order" | "overlap"
}

function toMatchedCell(cell: FileTargetCellRef, text: string, ref: string): FileTargetMatchedCell {
  const currentText = cell.translated ?? ""
  return {
    cellId: cell.cellId,
    fileId: cell.fileId,
    incomingText: text,
    currentText,
    hasConflict: currentText.trim().length > 0,
    parentId: cell.targetEventId ?? cell.sourceEventId ?? "",
    ref,
    sourceText: cell.original,
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
  const orphans: { ref: string; text: string }[] = []
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

  return {
    matched,
    orphans,
    unmatchedSourceCount: cells.length - matchedCellIds.size,
  }
}

/** How far apart two cue ranges may sit and still be considered the same cue.
 *  Only consulted when the ranges do not overlap at all: a cue shorter than
 *  the deliverables' frame-grid drift can slide clear of its counterpart, and
 *  a half-second window recovers it without ever reaching a neighbouring cue
 *  (partner subtitle cues are ~0.4s and up, separated by real gaps). */
const CUE_MATCH_TOLERANCE_MS = 500

/** Cue timing for an incoming row, in ms. Explicit `startMs`/`endMs` win; a
 *  row whose `ref` is a cue timecode range (`00:01:03.208 --> 00:01:03.667`,
 *  which is how the VTT target import labels its rows) carries its timings
 *  there, so recover them rather than requiring every caller to restate them. */
function rowTimingMs(row: TargetRow): { startMs: number; endMs: number } | null {
  if (row.startMs !== undefined && row.endMs !== undefined) {
    return { startMs: row.startMs, endMs: row.endMs }
  }
  const range = row.ref ? parseCueRange(row.ref) : null
  if (!range) return null
  return { startMs: Math.round(range.start * 1000), endMs: Math.round(range.end * 1000) }
}

function cellTimingMs(cell: FileTargetCellRef): { startMs: number; endMs: number } | null {
  if (cell.startMs === undefined || cell.endMs === undefined) return null
  return { startMs: cell.startMs, endMs: cell.endMs }
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
  const orphans: { ref: string; text: string }[] = []
  let matchedCount = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row.text.trim()) continue
    const cell = cells[i]
    if (!cell) {
      orphans.push({ ref: row.ref ?? `Row ${i + 1}`, text: row.text })
      continue
    }
    matchedCount++
    matched.push(toMatchedCell(cell, row.text, row.ref ?? cell.canonicalRef ?? `Row ${i + 1}`))
  }

  return {
    matched,
    orphans,
    unmatchedSourceCount: cells.length - matchedCount,
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
): FileTargetMatchResult {
  // Rows carrying no text can't commit anything, and must not hold a cell
  // hostage — a blank incoming cue never clears an existing translation.
  const timedRows = rows
    .map((row, index) => ({ row, index, timing: rowTimingMs(row) }))
    .filter((r) => r.row.text.trim().length > 0)

  const timedCells = cells
    .map((cell, index) => ({ cell, index, timing: cellTimingMs(cell) }))
    .filter((c): c is { cell: FileTargetCellRef; index: number; timing: { startMs: number; endMs: number } } =>
      c.timing !== null,
    )
    // Start-ordered so a row can stop scanning at the first cell that begins
    // beyond its reach. Incoming cues are NOT reliably time-ordered (real
    // partner files carry out-of-order timestamps), so each row rescans from
    // the front rather than advancing a shared pointer — quadratic in
    // principle, but on the ~500-cue episode files this exists for that is a
    // few hundred thousand integer comparisons.
    .sort((a, b) => a.timing.startMs - b.timing.startMs || a.index - b.index)

  type Candidate = { rowAt: number; cellAt: number; overlap: number; gap: number }
  const candidates: Candidate[] = []

  for (let r = 0; r < timedRows.length; r++) {
    const timing = timedRows[r].timing
    if (!timing) continue
    for (let c = 0; c < timedCells.length; c++) {
      const cellTiming = timedCells[c].timing
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
      timedRows[a.rowAt].index - timedRows[b.rowAt].index ||
      timedCells[a.cellAt].index - timedCells[b.cellAt].index,
  )

  const cellForRow = new Map<number, number>()
  const takenCells = new Set<number>()
  for (const candidate of candidates) {
    if (cellForRow.has(candidate.rowAt) || takenCells.has(candidate.cellAt)) continue
    cellForRow.set(candidate.rowAt, candidate.cellAt)
    takenCells.add(candidate.cellAt)
  }

  const matched: FileTargetMatchedCell[] = []
  const orphans: { ref: string; text: string }[] = []

  // Emit in incoming-file order so the review list reads like the user's file.
  for (let r = 0; r < timedRows.length; r++) {
    const { row, index } = timedRows[r]
    const cellAt = cellForRow.get(r)
    if (cellAt === undefined) {
      orphans.push({ ref: row.ref ?? `Row ${index + 1}`, text: row.text })
      continue
    }
    const cell = timedCells[cellAt].cell
    // The cue's timecode is the only meaningful label a VTT row has — a
    // cue-sourced cell's `canonicalRef` is an opaque group id.
    matched.push(toMatchedCell(cell, row.text, row.ref ?? cell.canonicalRef ?? `Row ${index + 1}`))
  }

  return {
    matched,
    orphans,
    unmatchedSourceCount: cells.length - matched.length,
    alignedBy: "overlap",
  }
}

/** Positional matching for formats that carry no canonical refs.
 *
 *  When the file's cells AND every non-empty incoming row carry cue timings,
 *  rows are aligned by timecode overlap (`matchTargetRowsByOverlap`), which
 *  survives an inserted, deleted, or shifted cue. Otherwise — no timings on
 *  either side, e.g. a spreadsheet with no ref column, or a partially timed
 *  file — it falls back to raw order, row N → cell N, exactly as before.
 *
 *  The result's `alignedBy` says which ran, so the review screen only warns
 *  about order alignment when order alignment is what happened. */
export function matchTargetRowsByOrder(
  rows: TargetRow[],
  cells: FileTargetCellRef[],
): FileTargetMatchResult {
  const nonEmptyRows = rows.filter((row) => row.text.trim().length > 0)
  const canMatchByOverlap =
    cells.length > 0 &&
    nonEmptyRows.length > 0 &&
    cells.every((cell) => cellTimingMs(cell) !== null) &&
    nonEmptyRows.every((row) => rowTimingMs(row) !== null)

  return canMatchByOverlap
    ? matchTargetRowsByOverlap(rows, cells)
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
  // Short-form timestamps are padded first. The parser demands strict
  // `HH:MM:SS.mmm`, and a cue it refuses does not arrive untimed — the payload
  // lines after the unmatched timestamp are swallowed and the cue disappears
  // with its words. Positional matching then shifts every later cue onto the
  // wrong cell, which nothing downstream can detect and nobody spots on a
  // 500-row review screen.
  const cues = extractVttStrings(repairShortFormCueTimestamps(raw).text)
  return cues.map((cue) => ({
    ref: cue.context,
    text: decodeSubtitleEntities(cue.original).trim(),
  }))
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
  const cues = ext === "sbv" ? extractSbvStrings(raw) : extractSrtStrings(raw)
  return cues.map((cue) => ({
    ref: cue.context || undefined,
    text: cue.original,
    ...(cue.start !== undefined && cue.end !== undefined
      ? { startMs: Math.round(cue.start * 1000), endMs: Math.round(cue.end * 1000) }
      : {}),
  }))
}
