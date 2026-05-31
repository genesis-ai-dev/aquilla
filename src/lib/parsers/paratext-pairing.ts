// Pair a TARGET translation (the consultant's in-progress Paratext project)
// to a SOURCE Bible (chosen from the eBible corpus) by canonical verse ref.
//
// The on-ramp for a UBS consultant importing work-in-progress: they pick a
// source that's "close, not precise", and we align it to their text verse by
// verse. Refs present on only one side simply leave the other blank — a
// low-resource target with gaps, or a fuller source, both import cleanly.
//
// This is the pure alignment core. It produces one bilingual plan per book
// (source text + target text, keyed by a shared cellId). The event emission
// (source.cell.create + target.cell.commit, same cellId) is layered on top.

import { v7 as uuidv7 } from "uuid"
import { parseUsfmLossless } from "./usfm-lossless"
import { getBookName, getBookOrdinal } from "../file-labeling/bible-book-names"
import { bookDisplayName, type ParatextBookName } from "./paratext"

/** A source verse keyed by canonical ref (e.g. from parseEBibleCorpus). */
export interface SourceVerse {
  ref: string
  text: string
}

export interface PairedRow {
  /** Canonical verse ref, e.g. "MAT 1:1". Doubles as the cell pairing key. */
  ref: string
  /** Source text (eBible). Empty when the source lacks this verse. */
  sourceText: string
  /** Target text (the consultant's translation). Empty when absent. */
  targetText: string
}

export interface PairedBook {
  bookId: string
  displayName: string
  corpusMarker: "OT" | "NT" | undefined
  order: number
  rows: PairedRow[]
  /** Counts for a quick "how aligned is this?" signal in the UI. */
  bothCount: number
  sourceOnlyCount: number
  targetOnlyCount: number
}

const NT_START_ORDINAL = 39

function corpusOf(order: number): "OT" | "NT" | undefined {
  if (order < 0) return undefined
  return order >= NT_START_ORDINAL ? "NT" : "OT"
}

/** Parse "GEN 1:1" / "GEN 1:1-3" / "GEN 1:1a" → a comparable numeric key.
 *  Sorts by chapter then the first verse number; non-numeric suffixes ignored. */
function refSortKey(ref: string): number {
  const m = ref.match(/\s(\d+):(\d+)/)
  if (!m) return Number.MAX_SAFE_INTEGER
  return parseInt(m[1], 10) * 100000 + parseInt(m[2], 10)
}

function bookOf(ref: string): string {
  return ref.split(" ")[0]?.toUpperCase() ?? ""
}

/**
 * Build per-book bilingual plans aligning each target book's verses to the
 * chosen source verses by ref.
 *
 * @param targetBooks  the Paratext project's books (raw USFM + book id)
 * @param sourceVerses the chosen source (eBible) verses, any books
 * @param bookNames    optional localized names for display
 */
export function pairSourceTarget(
  targetBooks: { bookId: string; rawSource: string }[],
  sourceVerses: SourceVerse[],
  bookNames?: Map<string, ParatextBookName>,
): PairedBook[] {
  // Index source verses by book → (ref → text).
  const sourceByBook = new Map<string, Map<string, string>>()
  for (const v of sourceVerses) {
    const book = bookOf(v.ref)
    if (!book) continue
    let m = sourceByBook.get(book)
    if (!m) sourceByBook.set(book, (m = new Map()))
    if (!m.has(v.ref)) m.set(v.ref, v.text) // first wins on dup refs
  }

  const out: PairedBook[] = []
  for (const book of targetBooks) {
    const bookId = book.bookId.toUpperCase()
    const doc = parseUsfmLossless(book.rawSource)
    const targetMap = new Map<string, string>()
    for (const verse of doc.verses) {
      if (!targetMap.has(verse.ref)) targetMap.set(verse.ref, verse.text.trim())
    }
    const sourceMap = sourceByBook.get(bookId) ?? new Map<string, string>()

    // Union of refs, canonical order.
    const refs = new Set<string>([...targetMap.keys(), ...sourceMap.keys()])
    const ordered = [...refs].sort((a, b) => refSortKey(a) - refSortKey(b))

    let both = 0
    let sourceOnly = 0
    let targetOnly = 0
    const rows: PairedRow[] = ordered.map((ref) => {
      const sourceText = sourceMap.get(ref) ?? ""
      const targetText = targetMap.get(ref) ?? ""
      if (sourceText && targetText) both++
      else if (sourceText) sourceOnly++
      else if (targetText) targetOnly++
      return { ref, sourceText, targetText }
    })

    const order = getBookOrdinal(bookId)
    out.push({
      bookId,
      displayName: bookDisplayName(bookId, bookNames, getBookName(bookId)),
      corpusMarker: corpusOf(order),
      order: order < 0 ? 9999 : order,
      rows,
      bothCount: both,
      sourceOnlyCount: sourceOnly,
      targetOnlyCount: targetOnly,
    })
  }

  out.sort((a, b) => a.order - b.order)
  return out
}

/** One verse row as a paired cell: source + target share a cellId so the
 *  editor lines them up (source.cell.create + target.cell.commit, same id). */
export interface BilingualCell {
  cellId: string
  ref: string
  sourceText: string
  targetText: string
}

export interface BilingualBookPlan {
  bookId: string
  displayName: string
  corpusMarker: "OT" | "NT" | undefined
  order: number
  /** The TARGET (Paratext) raw bytes — the round-trip side-car for exporting
   *  the consultant's translation back out. The source side is reference text
   *  only and needs no side-car. */
  rawSource: string
  cells: BilingualCell[]
  bothCount: number
  sourceOnlyCount: number
  targetOnlyCount: number
}

/**
 * Turn a target Paratext project + a chosen source into per-book bilingual
 * import plans: one file per book, each verse a paired cell (shared cellId)
 * carrying source (eBible reference) and target (the translation) text. This
 * is exactly what the emission layer consumes — source.cell.create with the
 * source text, target.cell.commit with the target text, same cellId — so the
 * consultant lands in a side-by-side editor of their work against a reference.
 */
export function buildBilingualPlan(
  targetBooks: { bookId: string; rawSource: string }[],
  sourceVerses: SourceVerse[],
  bookNames?: Map<string, ParatextBookName>,
): BilingualBookPlan[] {
  const rawByBook = new Map(targetBooks.map((b) => [b.bookId.toUpperCase(), b.rawSource]))
  return pairSourceTarget(targetBooks, sourceVerses, bookNames).map((book) => ({
    bookId: book.bookId,
    displayName: book.displayName,
    corpusMarker: book.corpusMarker,
    order: book.order,
    rawSource: rawByBook.get(book.bookId) ?? "",
    cells: book.rows.map((r) => ({
      cellId: uuidv7(),
      ref: r.ref,
      sourceText: r.sourceText,
      targetText: r.targetText,
    })),
    bothCount: book.bothCount,
    sourceOnlyCount: book.sourceOnlyCount,
    targetOnlyCount: book.targetOnlyCount,
  }))
}
