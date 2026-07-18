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

export interface CellNumberLabelInput {
  lineNumbersEnabled: boolean
  cellType: string | null | undefined
  canonicalRef: string | null | undefined
  sourceCanonicalRef?: string | null
  scriptureNumbering: boolean
  rowIndex: number
  /**
   * 1-based ordinal among *numbered* (non-paratext) cells, used only by the
   * sequential (non-scripture) numbering path. Passing it makes numbering start
   * at 1 at the first real content cell and stay gap-free, rather than tracking
   * the absolute display row — so leading/interspersed front matter,
   * introductions, and other paratextual cells no longer offset the count
   * (AQU-610). Falls back to `rowIndex + 1` when not supplied.
   */
  contentNumber?: number
}

/**
 * Resolve the editor gutter label without letting non-verse Paratext rows
 * shift scripture numbering. The target side often has no canonical_ref of
 * its own, so `sourceCanonicalRef` keeps a paired target row on the source
 * verse number.
 */
export function cellNumberLabel({
  lineNumbersEnabled,
  cellType,
  canonicalRef,
  sourceCanonicalRef,
  scriptureNumbering,
  rowIndex,
  contentNumber,
}: CellNumberLabelInput): string | null {
  if (!lineNumbersEnabled || cellType === "paratext") return null

  const canonicalVerse = verseLabelFromCanonical(canonicalRef)
    ?? verseLabelFromCanonical(sourceCanonicalRef)
  if (canonicalVerse) return canonicalVerse

  return scriptureNumbering ? null : String(contentNumber ?? rowIndex + 1)
}

/** Friendly chapter label for editor wayfinding (`MAT 1` → `Matthew 1`). */
export function chapterLabelFromCanonical(value: string | null | undefined): string | null {
  const ref = parseScriptureReference(value)
  return ref ? `${ref.bookName} ${ref.chapter}` : null
}
