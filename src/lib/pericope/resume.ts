import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
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

export interface PericopeResumeOptions {
  /**
   * The book the translator is actually looking at, when the caller knows it
   * (the editor reads it off the cell in the viewport). A file that addresses
   * more than one book resumes in this one, so the passages offered belong to
   * the book on screen rather than to whichever book the file opens with.
   */
  preferBook?: string | null
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
  options?: PericopeResumeOptions,
): PericopeResumeContext | null {
  return resolvePericopeResumeBy(cells, (cell) => cell, options)
}

/**
 * The same walk over ids a caller reads lazily — the editor holds cell ids and
 * a store, not an array of cells, and a book whose first thousand verses are
 * done should not materialize a thousand view models to learn that verse 1001
 * is next. `read` may return `null` for an id the store no longer has.
 *
 * AQU-2158: which book the file is *about* is no longer "whichever ref parses
 * first". A single leading ref addressed elsewhere — a stray cell, front
 * matter carried over from another book, a concatenated import — used to
 * capture the book for the whole file, and the editor then offered Genesis
 * passages to a translator with Hosea open. The book is now `preferBook` when
 * the file actually addresses it, else the book most of the file's cells
 * address; the resume point is the first untranslated cell *in that book*.
 */
export function resolvePericopeResumeBy<T>(
  items: readonly T[],
  read: (item: T) => PericopeResumeCell | null | undefined,
  { preferBook }: PericopeResumeOptions = {},
): PericopeResumeContext | null {
  const wanted = (preferBook ?? "").toUpperCase()
  if (wanted && isKnownBookCode(wanted)) {
    const resume = resumeWithinBook(items, read, wanted)
    // `undefined` = the file does not address that book at all, so the
    // viewport told us nothing useful; anything else is this book's answer,
    // including "fully translated, nothing left to suggest".
    if (resume !== undefined) return resume
  }
  const book = prevalentBook(items, read)
  return book ? resumeWithinBook(items, read, book) ?? null : null
}

/**
 * First untranslated cell in `book`, `null` when the book is present but
 * finished, `undefined` when no cell in the file addresses it.
 */
function resumeWithinBook<T>(
  items: readonly T[],
  read: (item: T) => PericopeResumeCell | null | undefined,
  book: string,
): PericopeResumeContext | null | undefined {
  let present = false
  for (const item of items) {
    const cell = read(item)
    if (!cell?.canonicalRef) continue
    const parsed = parseRef(cell.canonicalRef)
    if (!parsed || parsed.book !== book) continue
    present = true
    if (!cell.translated) return { book, from: parsed.address }
  }
  return present ? null : undefined
}

/**
 * The book most of the file's cells address — the file's own subject, rather
 * than the first ref to parse. Ties go to the book that appears earliest, so a
 * single-book file keeps answering exactly as it always did.
 */
function prevalentBook<T>(
  items: readonly T[],
  read: (item: T) => PericopeResumeCell | null | undefined,
): string | undefined {
  const counts = new Map<string, number>()
  for (const item of items) {
    const cell = read(item)
    if (!cell?.canonicalRef) continue
    const parsed = parseRef(cell.canonicalRef)
    if (!parsed) continue
    counts.set(parsed.book, (counts.get(parsed.book) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  // Map iteration is insertion-ordered, so `>` alone makes the earliest book win a tie.
  for (const [book, count] of counts) {
    if (count > bestCount) {
      best = book
      bestCount = count
    }
  }
  return best
}
