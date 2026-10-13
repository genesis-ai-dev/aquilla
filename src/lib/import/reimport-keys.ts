/**
 * How a parsed import result is looked up in `ImportContext.reimportFileIds`
 * (the in-place re-import that keeps a file's translations), and which books
 * it holds.
 *
 * Kept out of `@/lib/import` so the Import dialog, which builds those maps
 * (the collision screen's "Update existing", AQU-1365's "A new version of
 * Jonah's source text"), can share the exact lookup `emitParsedFile` does, and its tests can
 * run it for real while `@/lib/import` is mocked.
 */

import { SCRIPTURE_FILE_TYPES, type FileType } from "@/lib/parsers/types"
import type { TranslatableString } from "@/lib/parsers/core-types"
import { bookCodeForString } from "@/lib/import/split-by-book"

export interface ReimportKeyed {
  name: string
  originalName?: string
  bookCode?: string
}

/** The keys `emitParsedFile` tries, in order: book code (uppercase), then the
 *  result's name and original name (lowercased, trimmed). */
export function reimportKeysFor(result: ReimportKeyed): string[] {
  return [
    result.bookCode?.trim().toUpperCase(),
    result.name.trim().toLowerCase(),
    result.originalName?.trim().toLowerCase(),
  ].filter((key): key is string => Boolean(key))
}

/**
 * The books one parsed result holds, uppercased, in order.
 *
 * AQU-1365 review: an uploaded USFM file's parse carries no `bookCode` (only
 * the eBible/Hello AO split sets one), so reading `result.bookCode` alone made
 * the "Is this a translation?" book check blind to every real USFM upload.
 * The book is read the way the per-book split reads it, off each line's
 * section or reference ("JON 1" → JON), and only for scripture parses, so a
 * spreadsheet row whose context happens to be "Job" is not a book.
 */
export function parsedResultBooks(
  fileType: FileType,
  result: { bookCode?: string; strings: readonly TranslatableString[] },
): string[] {
  const stored = result.bookCode?.trim().toUpperCase()
  if (stored) return [stored]
  if (!SCRIPTURE_FILE_TYPES.has(fileType)) return []
  const books: string[] = []
  for (const string of result.strings) {
    const code = bookCodeForString(string)
    if (code && !books.includes(code)) books.push(code)
  }
  return books
}
