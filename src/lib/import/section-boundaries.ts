// The CC0 OpenBible section-counts dataset, compiled (AQU-1387 / AQU-515).
//
// Upstream publishes, for every section that any of 20 published English
// translations marks, the section's start verse, end verse, and how many of the
// 20 chose exactly that section:
//
//     https://a.openbible.info/data/bible-section-counts.txt   (CC0)
//     Gen.1.1  Gen.2.3  Gen.2.4  14
//
// What a passage layer needs is the other cut of that data: for each VERSE, how
// many translations begin a section there. Summing the counts of every row
// sharing a start verse gives exactly that — each translation contributes at
// most one section per start verse, which is why the sums come out at or below
// 20 (Gen.1.1 is 20/20; Luke 5:1, 5:12, 5:17 and 5:27 are 19/20).
//
// `scripts/build-section-boundaries.ts` does that summing once, converts the
// upstream OSIS-ish book abbreviations to the USFM codes the rest of the app
// speaks, and writes `./data/section-boundaries.ts`. Compiling at build time
// rather than at runtime is what keeps this a pure lookup with no fetch, no
// parse of 400 KB of TSV, and no network dependency in a test.
//
// The dataset covers the 66-book Protestant canon only. Deuterocanon, and any
// chapter it does not index, are "silent" rather than "no boundaries here" —
// `covers()` is the distinction, and a silent chapter routes the decision to the
// model instead (see `./passages.ts`).

/** Translations in the upstream panel; a strength's denominator. */
export const SECTION_COUNT_TRANSLATIONS = 20

export interface SectionBoundaryIndex {
  /**
   * Translations (of 20) that start a section at this verse, or `undefined`
   * when the dataset does not index the verse at all.
   */
  strengthAt(book: string, chapter: number, verse: number): number | undefined
  /**
   * Whether the dataset has an opinion about this chapter. False means silent,
   * which callers must not read as "no boundaries".
   */
  covers(book: string, chapter: number): boolean
  /** Section-start verses in a chapter, ascending. Empty when not covered. */
  startsIn(book: string, chapter: number): readonly { verse: number; translations: number }[]
  /** Chapters indexed, for the eval and for coverage reporting. */
  chapterCount: number
}

/**
 * Parse the compiled format: one line per chapter — `BOOK.CHAPTER` followed by
 * `verse:translations` pairs.
 *
 *     LUK.5 1:19 12:19 17:19 27:19 29:1 33:18 36:2
 *
 * Blank lines and `#` comments (the provenance header) are skipped. A malformed
 * line is skipped rather than thrown on: a corrupted data file must degrade to
 * "the dataset is silent about that chapter", never break an import.
 */
export function parseSectionBoundaries(text: string): SectionBoundaryIndex {
  const chapters = new Map<string, Map<number, number>>()
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const [head, ...verses] = line.split(/\s+/)
    const match = head.match(/^(.+?)\.(\d+)$/)
    if (!match || verses.length === 0) continue
    const chapterKey = `${match[1].toUpperCase()}.${Number(match[2])}`
    const entries = chapters.get(chapterKey) ?? new Map<number, number>()
    for (const token of verses) {
      const [verse, translations] = token.split(":")
      const verseNumber = Number(verse)
      const count = Number(translations)
      if (!Number.isInteger(verseNumber) || !Number.isFinite(count)) continue
      entries.set(verseNumber, count)
    }
    if (entries.size > 0) chapters.set(chapterKey, entries)
  }
  return index(chapters)
}

function index(chapters: Map<string, Map<number, number>>): SectionBoundaryIndex {
  const key = (book: string, chapter: number) => `${book.toUpperCase()}.${chapter}`
  return {
    strengthAt(book, chapter, verse) {
      return chapters.get(key(book, chapter))?.get(verse)
    },
    covers(book, chapter) {
      return chapters.has(key(book, chapter))
    },
    startsIn(book, chapter) {
      const entries = chapters.get(key(book, chapter))
      if (!entries) return []
      return [...entries.entries()]
        .map(([verse, translations]) => ({ verse, translations }))
        .sort((left, right) => left.verse - right.verse)
    },
    chapterCount: chapters.size,
  }
}

let loaded: Promise<SectionBoundaryIndex> | null = null

/**
 * The compiled dataset, parsed once per session.
 *
 * Loaded through a dynamic import so the ~50 KB of data stays out of the main
 * bundle: passages are computed in the background after import, never on a
 * path a first paint waits for. AQU-1287 moves this kind of reference data to
 * R2; when it does, only this function changes.
 */
export function loadSectionBoundaries(): Promise<SectionBoundaryIndex> {
  if (!loaded) {
    loaded = import("./data/section-boundaries")
      .then((module) => parseSectionBoundaries(module.SECTION_BOUNDARIES_CC0))
      .catch(() => index(new Map()))
  }
  return loaded
}

/** Test seam: forget the memoized parse. */
export function __resetSectionBoundaries(): void {
  loaded = null
}
