// Verse refs and Macula word ids for Bible data checks (AQU-1688).
// Relative imports only, no DOM: shared with the workers.

const VERSE_REF = /^([1-3]?[A-Z]{2,3})\s+(\d+):(\d+)([a-z]?)(?:-(\d+)([a-z]?))?$/

export interface CellVerses {
  book: string
  /** Every verse the cell covers, in order, as pack refs ("JHN 4:7"). */
  verses: string[]
  /** A ref named part of a verse ("JHN 4:7a"). */
  partial: boolean
}

/**
 * The verses behind a cell's `globalReferences`. A bridge ("MRK 1:1-2", or
 * several refs) expands to each verse. Refs that are not verse refs (a heading's
 * "JHN 4") are ignored. Null when nothing is a verse ref, or the refs mix books
 * or run backwards.
 */
export function expandCellRefs(refs: readonly string[]): CellVerses | null {
  let book: string | null = null
  let partial = false
  const verses: string[] = []
  for (const raw of refs) {
    const match = VERSE_REF.exec(raw.trim())
    if (!match) continue
    const [, code, chapter, first, firstPart, last, lastPart] = match
    if (book !== null && book !== code) return null
    book = code
    if (firstPart || lastPart) partial = true
    const from = Number.parseInt(first, 10)
    const to = last === undefined ? from : Number.parseInt(last, 10)
    if (to < from) return null
    for (let verse = from; verse <= to; verse++) {
      const ref = `${code} ${Number.parseInt(chapter, 10)}:${verse}`
      if (!verses.includes(ref)) verses.push(ref)
    }
  }
  if (book === null || verses.length === 0) return null
  return { book, verses, partial }
}

/** "n43004009008" → chapter 4. Macula ids are "n" + book(2) + chapter(3) + verse(3) + word(3). */
export function wordChapter(wordId: string): number {
  return Number.parseInt(wordId.slice(3, 6), 10)
}

export function wordVerse(wordId: string): number {
  return Number.parseInt(wordId.slice(6, 9), 10)
}

/** The word's position in its verse, counting from 1. */
export function wordNumber(wordId: string): number {
  return Number.parseInt(wordId.slice(9, 12), 10)
}

/** The id of the word at `position` in the same verse as `wordId`. */
export function siblingWordId(wordId: string, position: number): string {
  return `${wordId.slice(0, 9)}${String(position).padStart(3, '0')}`
}

/** The verse ref a word belongs to, e.g. ("JHN", "n43004009008") → "JHN 4:9". */
export function wordRef(book: string, wordId: string): string {
  return `${book} ${wordChapter(wordId)}:${wordVerse(wordId)}`
}
