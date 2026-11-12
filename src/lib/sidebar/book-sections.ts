import {
  getBookName,
  getBookOrdinal,
  isKnownBookCode,
} from "@/lib/file-labeling/bible-book-names"

/**
 * One book's chapters inside a single file (AQU-1187).
 *
 * A Bible imported before the per-book split — or any future multi-book file —
 * is one file holding every chapter of every book. Rendered flat that is a
 * 1,189-row spine with no way to reach a book, so the sidebar and the toolbar
 * chapter picker both group their rows with these.
 */
export interface BookChapterGroup<T> {
  /**
   * Stable identity for the group, used as the React key and as the persisted
   * collapse id: the book's display name ("Genesis"), or its raw code when we
   * have no name for it. Never a translated string — collapse state is keyed on
   * it, so translating it would lose every collapsed book on a locale switch.
   */
  id: string
  /** Canonical order index, Genesis = 0 (see `getBookOrdinal`). */
  ordinal: number
  chapters: T[]
}

/** The chapter entry fields the grouping reads. */
export interface GroupableChapter {
  /** `"scripture:GEN:1"` for milestone-derived chapters; the label otherwise. */
  key: string
  /** Display label, e.g. `"Genesis 1"`. */
  label: string
}

/** `"scripture:GEN:1"` → `"GEN"`. Undefined for any other key shape. */
export function bookCodeFromChapterKey(key: string): string | undefined {
  const code = /^scripture:([^:]+):/.exec(key)?.[1]
  return code && isKnownBookCode(code) ? code.toUpperCase() : undefined
}

/**
 * The book a chapter row belongs to, as a stable id plus its canonical order.
 *
 * Prefers the `scripture:BOOK:chapter` milestone key, which is exact. Falls
 * back to the display label with its trailing chapter number stripped
 * ("Genesis 1" → "Genesis"), which is how chapters that arrived from the
 * `/progress` endpoint — where the key IS the label — still group.
 */
export function bookOfChapter(
  chapter: GroupableChapter,
): { id: string; ordinal: number } | undefined {
  const code = bookCodeFromChapterKey(chapter.key)
  if (code) return { id: getBookName(code) ?? code, ordinal: getBookOrdinal(code) }

  const name = chapter.label.replace(/\s+\d+(?:[-–:]\d+)?\s*$/, "").trim()
  if (!name) return undefined
  const ordinal = getBookOrdinal(name)
  if (ordinal < 0) return undefined
  // Normalize through the canon so "GEN 1" and "Genesis 1" land in one group.
  return { id: getBookName(name) ?? name, ordinal }
}

/**
 * Group a file's chapters into books, in canonical reading order.
 *
 * Returns `null` when the file is not a multi-book scripture file — fewer than
 * two books, or any chapter we cannot attribute to a book. Callers render the
 * flat list they always have in that case, which is what keeps per-book files
 * (USFM, Paratext) and non-scripture files looking exactly as before.
 */
export function groupChaptersByBook<T extends GroupableChapter>(
  chapters: readonly T[],
): BookChapterGroup<T>[] | null {
  if (chapters.length === 0) return null

  const groups: BookChapterGroup<T>[] = []
  const byId = new Map<string, BookChapterGroup<T>>()
  for (const chapter of chapters) {
    const book = bookOfChapter(chapter)
    if (!book) return null
    const existing = byId.get(book.id)
    if (existing) {
      existing.chapters.push(chapter)
      continue
    }
    const group: BookChapterGroup<T> = { id: book.id, ordinal: book.ordinal, chapters: [chapter] }
    byId.set(book.id, group)
    groups.push(group)
  }

  if (groups.length < 2) return null
  return groups.sort((left, right) => left.ordinal - right.ordinal)
}
