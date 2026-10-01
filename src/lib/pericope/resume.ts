import { parseRef, type VerseAddress } from "./sections"

/** The minimum a caller has to know about a cell to place the resume point. */
export interface PericopeResumeCell {
  canonicalRef?: string | null
  /** Whether this cell already carries target text. */
  translated: boolean
}

export interface PericopeResumeContext {
  /** USFM book code the file addresses. */
  book: string
  /** First verse still to be worked — where suggestions resume from. */
  from: VerseAddress
}

/**
 * Where in the book this translator left off (AQU-515).
 *
 * The resume point is the first cell with no target text, so re-opening a book
 * mid-way offers the passage after the work already done rather than sending
 * the translator back to chapter 1. A file with no scripture addresses (EBL,
 * prose, a media transcript) returns `null` — the caller shows nothing, and no
 * error, until the Jev-derived passages of AQU-1387 can cover those.
 *
 * `null` also means "nothing left here": a fully translated book has no next
 * passage to suggest.
 */
export function resolvePericopeResume(
  cells: readonly PericopeResumeCell[],
): PericopeResumeContext | null {
  return resolvePericopeResumeBy(cells, (cell) => cell)
}

/**
 * The same walk over ids a caller reads lazily — the editor holds cell ids and
 * a store, not an array of cells, and a book whose first thousand verses are
 * done should not materialize a thousand view models to learn that verse 1001
 * is next. `read` may return `null` for an id the store no longer has.
 */
export function resolvePericopeResumeBy<T>(
  items: readonly T[],
  read: (item: T) => PericopeResumeCell | null | undefined,
): PericopeResumeContext | null {
  let book: string | undefined
  for (const item of items) {
    const cell = read(item)
    if (!cell) continue
    const parsed = cell.canonicalRef ? parseRef(cell.canonicalRef) : undefined
    if (!parsed) continue
    book ??= parsed.book
    if (parsed.book !== book) continue
    if (!cell.translated) return { book, from: parsed.address }
  }
  return null
}
