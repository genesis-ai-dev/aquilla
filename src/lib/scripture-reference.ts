import { getBookName, isKnownBookCode } from "@/lib/file-labeling/bible-book-names"

export interface ScriptureReference {
  bookCode: string
  bookName: string
  chapter: string
  verse: string | null
}

const SCRIPTURE_REF_RE = /^([1-3]?[A-Z]{2,3})\s+(\d+)(?::(\d+[a-z]?(?:-\d+[a-z]?)?))?$/i

/** Parse a canonical scripture ref such as `MAT 1:4` or `GEN 1:1-3`. */
export function parseScriptureReference(value: string | null | undefined): ScriptureReference | null {
  const match = value?.trim().match(SCRIPTURE_REF_RE)
  if (!match) return null
  const bookCode = match[1].toUpperCase()
  if (!isKnownBookCode(bookCode)) return null
  return {
    bookCode,
    bookName: getBookName(bookCode) ?? bookCode,
    chapter: match[2],
    verse: match[3] ?? null,
  }
}

/** Canonical verse label for the editor gutter. Non-verse cells return null. */
export function verseLabelFromCanonical(value: string | null | undefined): string | null {
  return parseScriptureReference(value)?.verse ?? null
}

/** Friendly chapter label for editor wayfinding (`MAT 1` → `Matthew 1`). */
export function chapterLabelFromCanonical(value: string | null | undefined): string | null {
  const ref = parseScriptureReference(value)
  return ref ? `${ref.bookName} ${ref.chapter}` : null
}
