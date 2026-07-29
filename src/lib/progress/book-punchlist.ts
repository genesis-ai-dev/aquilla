// AQU-727: "mark book done" punch list.
//
// When a Project Lead affirms a book is done, the system must surface every
// verse in that book that was never validated — grouped by the last editor who
// touched it — so the team can be brought back to exactly the cells that slipped
// through (the "catch human error" signal from the feedback). This module is the
// pure computation: given a file's raw source+target cell rows and a book code,
// it returns the unvalidated cells grouped by last editor.
//
// Detection is purely shape-based, mirroring canonical-rollup: a cell belongs to
// the book when its canonical_ref parses to that book token. The affirmation is
// keyed on (project, book_code), so callers pass the target book_code and this
// filters the file's cells to it (correct for the 1:1 book:file common case AND
// for files that span multiple books).

import type { CellRow } from "@/lib/sync/cells-read-types"
import { parseCanonicalRef } from "./canonical-rollup"

/** One unvalidated cell in the punch list, with enough to jump to it. */
export interface PunchListCell {
  cellId: string
  /** Full canonical reference, e.g. "GEN 1:3". */
  ref: string
  /** Chapter number as a string, e.g. "1". */
  chapterLabel: string
  /** Verse label, e.g. "3" or "3-4". */
  verseLabel: string
  /** The author of the last target commit, or null when never translated. */
  lastEditor: string | null
  /** True when the target has non-empty content (translated but not validated);
   *  false when the cell was never translated at all. */
  filled: boolean
}

/** Unvalidated cells attributed to one last editor (null = never translated). */
export interface PunchListGroup {
  /** Username of the last editor, or null for the never-translated bucket. */
  editor: string | null
  cells: PunchListCell[]
  count: number
}

export interface BookPunchList {
  bookCode: string
  /** Total unvalidated cells across every group. */
  totalUnvalidated: number
  groups: PunchListGroup[]
}

function numericCompare(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb
  return a.localeCompare(b)
}

/**
 * Build the unvalidated-cell punch list for one book, grouped by last editor.
 *
 * Rows are the file's raw source+target cell rows (both sides). Source and
 * target are paired per cellId — `validated` and `lastEditor` come from the
 * target row; the canonical reference falls back to the source row (target-side
 * canonical_ref is often NULL) exactly as canonical-rollup's pairing does.
 *
 * A cell is in the punch list when its target is NOT validated — this includes
 * both "translated but never validated" (`filled: true`) and "never translated"
 * (`filled: false`), matching acceptance criterion 3 ("every cell with
 * validated = 0"). Groups are ordered by descending count (the systematic
 * offender surfaces first), with the never-translated bucket (editor null) last;
 * cells within a group are in canonical order.
 */
export function buildBookPunchList(rows: CellRow[], bookCode: string): BookPunchList {
  const sources = new Map<string, CellRow>()
  const targets = new Map<string, CellRow>()
  const order: string[] = []
  for (const row of rows) {
    if (row.side === "source") {
      if (!sources.has(row.cellId)) order.push(row.cellId)
      sources.set(row.cellId, row)
    } else {
      if (!sources.has(row.cellId) && !targets.has(row.cellId)) order.push(row.cellId)
      targets.set(row.cellId, row)
    }
  }

  const byEditor = new Map<string | null, PunchListCell[]>()
  let total = 0

  for (const cellId of order) {
    const source = sources.get(cellId)
    const target = targets.get(cellId)
    const parsed = parseCanonicalRef(target?.canonicalRef ?? source?.canonicalRef ?? null)
    if (!parsed || parsed.book !== bookCode) continue
    // Only unvalidated cells are on the punch list.
    if (target?.validated) continue

    const lastEditor = target?.lastEditor ?? null
    const filled = (target?.value ?? "").trim().length > 0
    const cell: PunchListCell = {
      cellId,
      ref: `${parsed.book} ${parsed.chapter}:${parsed.verse}`,
      chapterLabel: parsed.chapter,
      verseLabel: parsed.verse,
      lastEditor,
      filled,
    }
    const bucket = byEditor.get(lastEditor)
    if (bucket) bucket.push(cell)
    else byEditor.set(lastEditor, [cell])
    total++
  }

  const groups: PunchListGroup[] = [...byEditor.entries()].map(([editor, cells]) => {
    cells.sort((a, b) => {
      const byChapter = numericCompare(a.chapterLabel, b.chapterLabel)
      if (byChapter !== 0) return byChapter
      return numericCompare(a.verseLabel, b.verseLabel)
    })
    return { editor, cells, count: cells.length }
  })

  // Largest offender first; the never-translated bucket (null editor) always last.
  groups.sort((a, b) => {
    if ((a.editor === null) !== (b.editor === null)) return a.editor === null ? 1 : -1
    if (a.count !== b.count) return b.count - a.count
    return (a.editor ?? "").localeCompare(b.editor ?? "")
  })

  return { bookCode, totalUnvalidated: total, groups }
}
