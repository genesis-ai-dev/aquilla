import { usfmFromOsis } from "./osis"

/**
 * The OpenBible CC0 section-counts dataset, reduced to the shape the
 * suggester needs (AQU-515). See `ATTRIBUTION.md` for provenance and the
 * upstream column layout.
 */

/** A chapter/verse pair inside one book. */
export interface VerseAddress {
  chapter: number
  verse: number
}

export interface PericopeSection {
  /** USFM book code, e.g. `GEN`. */
  book: string
  start: VerseAddress
  end: VerseAddress
  /** How many of the 20 surveyed translations draw this exact section (1–20). */
  translations: number
}

/** Sections grouped by USFM book code, each list sorted by start then strength. */
export type PericopeIndex = ReadonlyMap<string, readonly PericopeSection[]>

/** Numeric order within a book. Negative when `a` precedes `b`. */
export function compareAddresses(a: VerseAddress, b: VerseAddress): number {
  return a.chapter !== b.chapter ? a.chapter - b.chapter : a.verse - b.verse
}

/** `"GEN 2:4"` — the `canonicalRef` spelling the rest of the app uses. */
export function formatRef(book: string, address: VerseAddress): string {
  return `${book} ${address.chapter}:${address.verse}`
}

/**
 * Parse a `canonicalRef` (`"GEN 2:4"`, `"1SA 3:1"`) into its parts.
 *
 * Tolerates the sub-verse suffixes importers sometimes attach (`"GEN 2:4a"`,
 * `"GEN 2:4-5"`) by taking the leading integer — a suggestion only needs to
 * know which verse a cell sits at, not how the importer split it.
 */
export function parseRef(ref: string): { book: string; address: VerseAddress } | undefined {
  const match = /^([A-Z0-9]{2,4})\s+(\d+):(\d+)/.exec(ref.trim().toUpperCase())
  if (!match) return undefined
  return {
    book: match[1]!,
    address: { chapter: Number(match[2]), verse: Number(match[3]) },
  }
}

function parseOsisRef(token: string): { book: string; address: VerseAddress } | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const book = usfmFromOsis(parts[0]!)
  const chapter = Number(parts[1])
  const verse = Number(parts[2])
  if (!book || !Number.isInteger(chapter) || !Number.isInteger(verse)) return undefined
  return { book, address: { chapter, verse } }
}

/**
 * Read the vendored dataset. Rows that do not match the documented four-column
 * shape — the `#` header, blank trailing lines, an unmapped book — are skipped
 * rather than thrown on, so a partially-changed upstream file degrades to fewer
 * suggestions instead of breaking the editor. The tests assert the real file
 * still yields all 66 books, which is what actually catches a shape change.
 */
export function parseSectionCounts(raw: string): PericopeSection[] {
  const sections: PericopeSection[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue
    const columns = line.split("\t")
    if (columns.length < 4) continue
    const start = parseOsisRef(columns[0]!)
    const end = parseOsisRef(columns[1]!)
    const translations = Number(columns[3])
    if (!start || !end || start.book !== end.book) continue
    if (!Number.isInteger(translations) || translations <= 0) continue
    sections.push({
      book: start.book,
      start: start.address,
      end: end.address,
      translations,
    })
  }
  return sections
}

/**
 * Group by book, each list ordered by start verse and, within one start verse,
 * strongest section first. That ordering is what lets the suggester take "the
 * next few options at this verse" with a slice instead of a sort per call.
 */
export function indexSections(sections: readonly PericopeSection[]): PericopeIndex {
  const byBook = new Map<string, PericopeSection[]>()
  for (const section of sections) {
    const list = byBook.get(section.book)
    if (list) list.push(section)
    else byBook.set(section.book, [section])
  }
  for (const list of byBook.values()) {
    list.sort((a, b) => (
      compareAddresses(a.start, b.start)
      || b.translations - a.translations
      || compareAddresses(a.end, b.end)
    ))
  }
  return byBook
}

/**
 * The boundary-strength prior for a verse: how many of the 20 translations
 * start a section there. 0 means no surveyed translation breaks at that verse.
 *
 * This is the per-verse score the ticket asks to precompute; it is derived on
 * read from the sorted index rather than materialized into a second table,
 * because the sorted list already answers it in a scan of one start group.
 */
export function boundaryScore(
  index: PericopeIndex,
  book: string,
  address: VerseAddress,
): number {
  const sections = index.get(book)
  if (!sections) return 0
  let best = 0
  for (const section of sections) {
    const order = compareAddresses(section.start, address)
    if (order < 0) continue
    if (order > 0) break
    // Sorted strongest-first inside one start verse, so the first hit wins.
    best = Math.max(best, section.translations)
    break
  }
  return best
}
