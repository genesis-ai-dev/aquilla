/**
 * The "Big Bible" fixture plan (AQU-1868): the 66-book, ~31k-cell project the
 * perf harness measures against, as DATA — no I/O, no ids, no network.
 *
 * Why a plan rather than a seeder that makes it up as it goes: the plan is the
 * part that has to be reproducible. A run that seeded 29k cells one week and
 * 33k the next would move every p95 in the report for a reason that has
 * nothing to do with the code under test. So the shape is pure and
 * deterministic (seeded PRNG, no `Date.now()`, no `Math.random`), and
 * `seed-big-bible.ts` is the only part that talks to the stack.
 *
 * The canon table is imported, not copied — see CHAPTERS_BY_BOOK in
 * `src/lib/__fixtures__/whole-bible-fixture.ts`. That fixture is the
 * CLIENT-side whole Bible (one file, 34k rows, for the editor's scaling
 * guards); this is the SERVER-side one (66 files, the real production shape of
 * a Bible project).
 */

import { CHAPTERS_BY_BOOK } from "../../../src/lib/__fixtures__/whole-bible-fixture"

/** Books in the plan, and the canonical chapter total across them. */
export const TOTAL_BOOKS = CHAPTERS_BY_BOOK.length
export const TOTAL_CHAPTERS = CHAPTERS_BY_BOOK.reduce((sum, [, n]) => sum + n, 0)

/**
 * Default size: the ticket's "~31k cells". 31,102 is the verse count of the
 * Protestant canon, so a reader comparing the harness to a real Bible project
 * recognizes the number.
 */
export const BIG_BIBLE_CELL_COUNT = 31_102

export interface BigBiblePlanOptions {
  /** Total cells across every book, headings included. Hit exactly. */
  targetCells?: number
  /** Only the first N books — a fast smoke of the seeder, not a perf run. */
  books?: number
  /** Fraction of verse cells that carry target text in the default lane. */
  translatedFraction?: number
  /** Fraction of TRANSLATED verse cells also committed in the second lane. */
  secondLaneFraction?: number
  /** PRNG seed. Fixed by default; change it only to prove a result is not seed-specific. */
  seed?: number
}

export interface PlannedCell {
  /** Stable, human-readable cell id — `GEN 1:1`, `GEN 1:0` for a chapter heading. */
  cellId: string
  canonicalRef: string | null
  /** `"heading"` for book/chapter headings, null for verses (matches the importer). */
  type: string | null
  text: string
  /** Target text for the project's first target lane, or null. */
  targetText: string | null
  /** Target text for the second lane, or null. */
  secondLaneText: string | null
}

export interface PlannedFile {
  bookCode: string
  /** File name as a USFM import would produce it. */
  name: string
  chapters: number
  cells: PlannedCell[]
}

export interface BigBiblePlan {
  files: PlannedFile[]
  stats: {
    files: number
    cells: number
    chapters: number
    verses: number
    headings: number
    translated: number
    secondLane: number
  }
}

/** mulberry32 — the same PRNG as `whole-bible-fixture.ts`, deterministic across engines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LOREM = [
  "in the beginning", "and the earth was", "without form and void",
  "and darkness was upon", "the face of the deep", "and the Spirit moved",
  "upon the face of", "the waters and God said", "let there be light",
  "and there was light", "and God saw the light", "that it was good",
]

function sentence(rand: () => number, words: number): string {
  const parts: string[] = []
  for (let index = 0; index < words; index++) parts.push(LOREM[Math.floor(rand() * LOREM.length)])
  return `${parts.join(" ")}.`
}

/**
 * Build the plan. Verses are spread evenly over the canon's 1,189 chapters and
 * the integer remainder is handed to the first chapters, so `targetCells` is
 * hit exactly — two plans of different sizes stay structurally identical
 * (same books, same chapters, same heading placement) and differ only in
 * depth, which is what makes a smaller run a valid shrink of the real one.
 */
export function planBigBible(options: BigBiblePlanOptions = {}): BigBiblePlan {
  const {
    targetCells = BIG_BIBLE_CELL_COUNT,
    books = TOTAL_BOOKS,
    translatedFraction = 0.35,
    secondLaneFraction = 0.4,
    seed = 1868,
  } = options

  const selected = CHAPTERS_BY_BOOK.slice(0, Math.max(1, Math.min(books, TOTAL_BOOKS)))
  const chapters = selected.reduce((sum, [, n]) => sum + n, 0)
  const headings = selected.length + chapters
  const verseBudget = Math.max(chapters, targetCells - headings)
  const versesPerChapter = Math.max(1, Math.floor(verseBudget / chapters))
  let extra = verseBudget - versesPerChapter * chapters

  const rand = mulberry32(seed)
  const files: PlannedFile[] = []
  let verses = 0
  let translated = 0
  let secondLane = 0

  for (const [bookCode, chapterCount] of selected) {
    const cells: PlannedCell[] = [
      {
        cellId: `${bookCode} title`,
        canonicalRef: null,
        type: "heading",
        text: `The Book of ${bookCode}`,
        targetText: null,
        secondLaneText: null,
      },
    ]
    for (let chapter = 1; chapter <= chapterCount; chapter++) {
      cells.push({
        cellId: `${bookCode} ${chapter}:0`,
        canonicalRef: `${bookCode} ${chapter}:0`,
        type: "heading",
        text: `Chapter ${chapter}`,
        targetText: null,
        secondLaneText: null,
      })
      let verseCount = versesPerChapter
      if (extra > 0) {
        verseCount++
        extra--
      }
      for (let verse = 1; verse <= verseCount; verse++) {
        const isTranslated = rand() < translatedFraction
        const inSecondLane = isTranslated && rand() < secondLaneFraction
        cells.push({
          cellId: `${bookCode} ${chapter}:${verse}`,
          canonicalRef: `${bookCode} ${chapter}:${verse}`,
          type: null,
          text: sentence(rand, 8 + Math.floor(rand() * 10)),
          targetText: isTranslated ? sentence(rand, 8 + Math.floor(rand() * 10)) : null,
          secondLaneText: inSecondLane ? sentence(rand, 8 + Math.floor(rand() * 10)) : null,
        })
        verses++
        if (isTranslated) translated++
        if (inSecondLane) secondLane++
      }
    }
    files.push({ bookCode, name: `${bookCode}.usfm`, chapters: chapterCount, cells })
  }

  return {
    files,
    stats: {
      files: files.length,
      cells: files.reduce((sum, file) => sum + file.cells.length, 0),
      chapters,
      verses,
      headings,
      translated,
      secondLane,
    },
  }
}
