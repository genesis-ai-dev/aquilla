// AQU-493: chapter/verse progress rollup (nested book › chapter › verse).
//
// Builds a book → chapter → verse progress tree from a file's raw
// source+target CellRow pairs (see `fetchAllFileCells` in cells-read.ts).
// Detection is purely shape-based — a cell "has a canonical reference" when
// its `canonicalRef` matches "TOKEN CHAPTER:VERSE" (e.g. "GEN 1:1", but
// equally "OBS 1:3" or any project-defined non-canonical book code). We
// never check the book token against a hardcoded book list, so files from
// non-Scripture or non-canonical corpora still get a correct nested rollup
// (or correctly get none, if their refs don't carry chapter:verse shape).

import type { CellRow } from "@/lib/sync/cells-read-types"

export interface VerseRollup {
  ref: string // e.g. "GEN 1:1"
  verseLabel: string // e.g. "1" or "1-2" for a verse range
  filled: boolean
  approved: boolean
}

export interface ChapterRollup {
  chapter: string // e.g. "GEN 1"
  chapterLabel: string // e.g. "1"
  cellCount: number
  filledCount: number
  approvedCount: number
  filledPct: number
  approvedPct: number
  verses: VerseRollup[]
}

export interface BookRollup {
  book: string // e.g. "GEN"
  cellCount: number
  filledCount: number
  approvedCount: number
  filledPct: number
  approvedPct: number
  chapters: ChapterRollup[]
}

export interface ParsedCanonicalRef {
  book: string
  chapter: string
  verse: string
}

// "TOKEN CH:V" or "TOKEN CH:V-V" (verse range). The book token is any
// non-whitespace run — deliberately not a closed enum of book codes.
const REF_RE = /^(\S+)\s+(\d+):(\d+)(?:-(\d+))?/

export function parseCanonicalRef(ref: string | null | undefined): ParsedCanonicalRef | null {
  if (!ref) return null
  const m = REF_RE.exec(ref.trim())
  if (!m) return null
  return { book: m[1], chapter: m[2], verse: m[4] ? `${m[3]}-${m[4]}` : m[3] }
}

/** True when at least one row carries a parseable "BOOK CH:V" reference —
 *  the signal that this file should get the nested rollup instead of the
 *  flat cell/file view. */
export function hasCanonicalReferences(rows: Pick<CellRow, "canonicalRef">[]): boolean {
  return rows.some((r) => parseCanonicalRef(r.canonicalRef) != null)
}

interface RollupCell {
  ref: ParsedCanonicalRef
  filled: boolean
  approved: boolean
}

/**
 * Pair source+target rows into one progress cell per cellId, mirroring the
 * file-level semantics in `FileSummary`: `filled` = target has non-empty
 * content ("translated"), `approved` = target's `validated` flag. A cellId
 * with no target row yet (untranslated) counts as unfilled/unapproved —
 * same as an untranslated row counting toward `cellCount` but not
 * `filledCount` at the file level.
 */
function pairCells(rows: CellRow[]): RollupCell[] {
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
  const out: RollupCell[] = []
  for (const cellId of order) {
    const source = sources.get(cellId)
    const target = targets.get(cellId)
    const ref = parseCanonicalRef(target?.canonicalRef ?? source?.canonicalRef ?? null)
    if (!ref) continue
    out.push({
      ref,
      filled: (target?.value ?? "").trim().length > 0,
      approved: target?.validated ?? false,
    })
  }
  return out
}

function pct(num: number, denom: number): number {
  return denom > 0 ? Math.round((num / denom) * 100) : 0
}

function numericCompare(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb
  return a.localeCompare(b)
}

/**
 * Build a book → chapter → verse progress rollup from a file's raw cell
 * rows. Returns `null` when no row carries a parseable canonical reference
 * — callers must fall back to the flat file/cell view rather than
 * rendering an empty tree (AQU-493 acceptance criteria).
 *
 * Percentages are computed bottom-up from raw counts (never averaged), so a
 * fully-filled/approved book reconciles to exactly 100% at every level —
 * see canonical-rollup.test.ts for the reconciliation proof.
 */
export function buildCanonicalRollup(rows: CellRow[]): BookRollup[] | null {
  const cells = pairCells(rows)
  if (cells.length === 0) return null

  const chaptersByBook = new Map<string, Map<string, RollupCell[]>>()
  const bookOrder: string[] = []
  for (const cell of cells) {
    const { book, chapter } = cell.ref
    let chapters = chaptersByBook.get(book)
    if (!chapters) {
      chapters = new Map()
      chaptersByBook.set(book, chapters)
      bookOrder.push(book)
    }
    const bucket = chapters.get(chapter)
    if (bucket) bucket.push(cell)
    else chapters.set(chapter, [cell])
  }

  return bookOrder.map((book) => {
    const chapters = chaptersByBook.get(book)!
    const chapterKeys = Array.from(chapters.keys()).sort(numericCompare)
    const chapterRollups: ChapterRollup[] = chapterKeys.map((chapterKey) => {
      const chapterCells = chapters.get(chapterKey)!
      const verses: VerseRollup[] = chapterCells
        .map((c) => ({
          ref: `${book} ${chapterKey}:${c.ref.verse}`,
          verseLabel: c.ref.verse,
          filled: c.filled,
          approved: c.approved,
        }))
        .sort((a, b) => numericCompare(a.verseLabel, b.verseLabel))
      const filledCount = chapterCells.filter((c) => c.filled).length
      const approvedCount = chapterCells.filter((c) => c.approved).length
      return {
        chapter: `${book} ${chapterKey}`,
        chapterLabel: chapterKey,
        cellCount: chapterCells.length,
        filledCount,
        approvedCount,
        filledPct: pct(filledCount, chapterCells.length),
        approvedPct: pct(approvedCount, chapterCells.length),
        verses,
      }
    })
    const cellCount = chapterRollups.reduce((n, c) => n + c.cellCount, 0)
    const filledCount = chapterRollups.reduce((n, c) => n + c.filledCount, 0)
    const approvedCount = chapterRollups.reduce((n, c) => n + c.approvedCount, 0)
    return {
      book,
      cellCount,
      filledCount,
      approvedCount,
      filledPct: pct(filledCount, cellCount),
      approvedPct: pct(approvedCount, cellCount),
      chapters: chapterRollups,
    }
  })
}
