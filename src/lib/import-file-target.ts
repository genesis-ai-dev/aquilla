// File-scoped target import: populate the open file's target column from a
// USFM file, a spreadsheet (CSV/TSV/XLSX) or a subtitle file (SRT/SBV —
// AQU-1144). Two match modes:
//
//   - by ref:   incoming rows carry canonical refs ("GEN 1:1") matched against
//               the file's cells (CellData.group) — same mechanism as the
//               eBible → target import (AQU-191).
//   - by order: Nth data row → Nth cell of the file. Fallback for spreadsheets
//               with no ref column, and the only mode for subtitle cues (their
//               cells carry opaque group ids, not canonical refs). The review
//               screen shows the cell's source text beside each incoming row
//               so misalignment is visible before anything is committed.
//
// The result shape is a structural superset of EBibleMatchResult, so
// applyEBibleTargetImport (lib/import.ts) applies the commits unchanged:
// target.cell.commit events, AD-2 parentId = targetEventId ?? sourceEventId.

import type { SourceCellRef, EBibleMatchedCell } from "./import"
import { parseUsfmLossless } from "./parsers/usfm-lossless"
import { extractSrtStrings } from "./parsers/subtitle"
import { extractSbvStrings } from "./parsers/sbv"

/** Cell descriptor for file-scoped matching — SourceCellRef plus the source
 *  text, which the review table shows so the user can eyeball alignment. */
export interface FileTargetCellRef extends SourceCellRef {
  original: string
}

/** One incoming translation row, from USFM or a mapped spreadsheet. */
export interface TargetRow {
  /** Canonical ref when the format carries one (USFM, ref-mapped sheets). */
  ref?: string
  text: string
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

/** Match rows to cells positionally: data row N → file cell N. Empty rows
 *  keep their slot (so alignment holds) but produce no commit. Rows beyond
 *  the file's cell count become orphans. */
export function matchTargetRowsByOrder(
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
    // Prefer the incoming row's own label when the format carries one. Cue
    // formats (AQU-1144) put the cue's timecode range here, which is the only
    // human-readable handle a cue row has — cue cells' group ids are opaque
    // uuids, so `cell.canonicalRef` would be absent anyway. Spreadsheet rows
    // matched by order carry no `ref`, so their behaviour is unchanged.
    matched.push(toMatchedCell(cell, row.text, row.ref ?? cell.canonicalRef ?? `Row ${i + 1}`))
  }

  return {
    matched,
    orphans,
    unmatchedSourceCount: cells.length - matchedCount,
  }
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
 *  group ids rather than canonical refs, so matching must be positional —
 *  cue N → cell N, via matchTargetRowsByOrder. Empty cues keep their slot so
 *  that alignment holds and never clear an existing translation.
 */
export function subtitleToTargetRows(raw: string, ext: string): TargetRow[] {
  const cues = ext === "sbv" ? extractSbvStrings(raw) : extractSrtStrings(raw)
  return cues.map((cue) => ({ ref: cue.context || undefined, text: cue.original }))
}
