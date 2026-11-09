// The Protestant canon's chapter counts (AQU-1735): 66 books, 1,189 chapters.
//
// Production data, not a fixture. It is what the scripture-reference check
// (src/lib/lqa/check-functions/scripture-reference.ts) means by "the project's
// versification" at chapter granularity: Psalms has 150 chapters, so a
// reference to Psalm 151 names a chapter the canon does not have.
//
// `src/lib/__fixtures__/whole-bible-fixture.ts` and the AQU-1868 perf harness
// re-export this table rather than keeping their own copy — two copies drift
// into two different "whole Bibles".
//
// Verse-level range checking (is Genesis 1:35 a verse?) needs a last-verse
// table per versification scheme, which this is not; see the AQU-1735 Linear
// thread for the follow-up.
//
// Dependency-free and pure.

/** `[USFM code, chapter count]` in canonical (Protestant) reading order. */
export const CANON_CHAPTERS: ReadonlyArray<readonly [code: string, chapters: number]> = [
  ["GEN", 50], ["EXO", 40], ["LEV", 27], ["NUM", 36], ["DEU", 34],
  ["JOS", 24], ["JDG", 21], ["RUT", 4],
  ["1SA", 31], ["2SA", 24], ["1KI", 22], ["2KI", 25],
  ["1CH", 29], ["2CH", 36], ["EZR", 10], ["NEH", 13], ["EST", 10],
  ["JOB", 42], ["PSA", 150], ["PRO", 31], ["ECC", 12], ["SNG", 8],
  ["ISA", 66], ["JER", 52], ["LAM", 5], ["EZK", 48], ["DAN", 12],
  ["HOS", 14], ["JOL", 3], ["AMO", 9], ["OBA", 1], ["JON", 4],
  ["MIC", 7], ["NAM", 3], ["HAB", 3], ["ZEP", 3], ["HAG", 2],
  ["ZEC", 14], ["MAL", 4],
  ["MAT", 28], ["MRK", 16], ["LUK", 24], ["JHN", 21], ["ACT", 28],
  ["ROM", 16], ["1CO", 16], ["2CO", 13], ["GAL", 6], ["EPH", 6],
  ["PHP", 4], ["COL", 4], ["1TH", 5], ["2TH", 3],
  ["1TI", 6], ["2TI", 4], ["TIT", 3], ["PHM", 1],
  ["HEB", 13], ["JAS", 5], ["1PE", 5], ["2PE", 3],
  ["1JN", 5], ["2JN", 1], ["3JN", 1], ["JUD", 1], ["REV", 22],
] as const

const BY_CODE: Readonly<Record<string, number>> = Object.fromEntries(CANON_CHAPTERS)

/** How many chapters the canon gives a book, or null for a code it does not
 *  have (a deuterocanonical book, or anything that is not a book code). */
export function canonChapterCount(code: string | null | undefined): number | null {
  return BY_CODE[(code ?? "").toUpperCase()] ?? null
}
