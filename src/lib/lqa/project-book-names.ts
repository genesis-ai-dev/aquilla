// AQU-1735: the project's own names for Bible books, for the
// scripture-reference check.
//
// The authority is whatever the project's files say they are: a file carries
// the `bookCode` its import recorded, plus the name it was imported under, the
// label an extension gave it, and (once renamed) its original name. A Paratext
// project import also parses `BookNames.xml` (src/lib/parsers/paratext.ts),
// and a USFM file's `\toc1–3` lines name the book in the project's own
// language — both of those reach a file's name through the importer, which is
// why reading the file list is enough and no new per-project setting is.
//
// The book's USFM code is added by the check itself, not here: a table built
// from file names would otherwise reject the code every project spells its own
// books with.
//
// Pure, so `useRules` can memoize it on the file list alone.

import type { FileReference } from "@/lib/parsers/types"
import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import type { ProjectBookName } from "./builtin-run-context"

/** The project's book-name table, or null when no file names a book — in
 *  which case the scripture-reference check has no spellings to insist on. */
export function projectBookNames(
  files: readonly FileReference[] | null | undefined,
): ProjectBookName[] | null {
  if (!files || files.length === 0) return null

  const namesByCode = new Map<string, Set<string>>()
  for (const file of files) {
    const code = file.bookCode?.toUpperCase()
    if (!code || !isKnownBookCode(code)) continue
    let names = namesByCode.get(code)
    if (!names) {
      names = new Set<string>()
      namesByCode.set(code, names)
    }
    for (const name of [file.displayLabel, file.name, file.originalName]) {
      const trimmed = name?.trim()
      if (trimmed) names.add(trimmed)
    }
  }

  if (namesByCode.size === 0) return null
  return [...namesByCode].map(([code, names]) => ({ code, names: [...names] }))
}
