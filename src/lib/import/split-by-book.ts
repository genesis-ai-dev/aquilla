import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import type { TranslatableString } from "@/lib/parsers/core-types"

/**
 * One book's worth of parsed cells, in the order the parser produced them.
 *
 * AQU-1187: the eBible and Hello AO importers used to emit the whole selection
 * as ONE file with no `bookCode`, which put a 66-book Bible in the sidebar's
 * "Ungrouped" bucket with no way to reach a book except paging chapter by
 * chapter, and produced the 31k-cell single files behind AQU-1047 / AQU-1160.
 * Splitting at parse time makes those imports look exactly like the USFM and
 * Paratext paths, which have always been one file per book.
 */
export interface BookSlice {
  /** USFM book code, uppercase (e.g. `"GEN"`). */
  bookCode: string
  strings: TranslatableString[]
}

/**
 * The USFM book code a scripture cell belongs to.
 *
 * Reads the `section` label the scripture parsers already set ("GEN 1" →
 * "GEN"), falling back to the cell's first global reference and then its
 * `context` ("GEN 1:1" → "GEN"). Returns undefined when the leading token is
 * not a book code we know, which is what keeps non-scripture content out of
 * the per-book split.
 */
export function bookCodeForString(string: TranslatableString): string | undefined {
  for (const candidate of [string.section, string.globalReferences?.[0], string.context]) {
    const head = candidate?.trim().split(/\s+/)[0]
    if (head && isKnownBookCode(head)) return head.toUpperCase()
  }
  return undefined
}

/**
 * Group parsed scripture cells into one slice per book, preserving the
 * parser's order (both scripture parsers emit canonical book order already).
 *
 * Returns `null` when the cells are not cleanly per-book — i.e. any cell whose
 * book we cannot name. Callers treat `null` as "emit one file exactly as
 * before", so a non-scripture import keeps its current shape. A single-book
 * selection comes back as a one-element array: still one file, but now one that
 * knows its `bookCode`.
 */
export function splitStringsByBook(
  strings: readonly TranslatableString[],
): BookSlice[] | null {
  if (strings.length === 0) return null

  const slices: BookSlice[] = []
  const byCode = new Map<string, BookSlice>()
  for (const string of strings) {
    const bookCode = bookCodeForString(string)
    // One unattributable cell means we cannot promise every cell landed in the
    // right book, so the whole import stays single-file rather than silently
    // dropping content into a neighbouring book.
    if (!bookCode) return null
    const existing = byCode.get(bookCode)
    if (existing) {
      existing.strings.push(string)
      continue
    }
    const slice: BookSlice = { bookCode, strings: [string] }
    byCode.set(bookCode, slice)
    slices.push(slice)
  }

  return slices
}
