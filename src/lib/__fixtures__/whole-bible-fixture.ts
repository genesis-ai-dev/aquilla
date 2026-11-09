/**
 * AQU-1047: a reproducible whole-Bible-in-one-file fixture (~34,000 cells).
 *
 * The production case behind the ticket is an entire Bible stored as ONE file:
 * 66 books, 1,189 chapters, ~31k verses, plus a heading cell per book and per
 * chapter. That shape is what makes any accidentally file-proportional work in
 * the editor visible — a 12-cell unit test cannot tell an O(1) path from an
 * O(N) one, and nobody keeps a 34k-cell project lying around to notice.
 *
 * So the fixture is generated rather than checked in as data: a few hundred
 * lines here beat a multi-megabyte blob in the tree, and a generated fixture
 * can be asked for at 4,000 cells as well as 34,000 — which is the whole point
 * of the scaling assertions in `useActiveCellStore.largeFile.test.ts`. If the
 * per-cell work at 34k equals the per-cell work at 4k, the path is
 * viewport-scoped; if it tracks the file size, it is not.
 *
 * Everything is DETERMINISTIC (seeded PRNG, no `Date.now()`, no `Math.random`)
 * so a count asserted today means the same thing on CI tomorrow.
 *
 * Consumers:
 *  - `src/hooks/useActiveCellStore.largeFile.test.ts` — the regression guards.
 *  - `src/hooks/useActiveCellStore.largeFile.bench.test.ts` — the benchmark.
 */

import type { CellRow } from "@/lib/sync/cells-read-types"
import { CANON_CHAPTERS } from "@/lib/bible-data/canon-chapters"

/**
 * Chapter counts for the 66-book Protestant canon, in canonical order — the
 * same order and codes as `src/lib/file-labeling/bible-book-names.ts`. Summing
 * to 1,189 matters: the navigation index builds one milestone per chapter, so
 * a fixture with the wrong chapter count exercises the wrong rollup width.
 *
 * Exported because the AQU-1868 "Big Bible" perf harness
 * (`scripts/perf/lib/big-bible-plan.ts`) seeds the SERVER-side shape of the
 * same canon — 66 files instead of one — and two copies of this table would
 * drift into two different "whole Bibles".
 */
export const CHAPTERS_BY_BOOK = CANON_CHAPTERS

export const TOTAL_BOOKS = CHAPTERS_BY_BOOK.length
export const TOTAL_CHAPTERS = CHAPTERS_BY_BOOK.reduce((sum, [, n]) => sum + n, 0)

/** The ticket's production scale: "an entire Bible in one file (~34,000 cells)". */
export const WHOLE_BIBLE_CELL_COUNT = 34_000

export interface WholeBibleFixtureOptions {
  /**
   * Total cells to emit (heading cells included). Defaults to the ticket's
   * ~34,000. Verses per chapter are scaled to land on this number exactly, so
   * two fixtures of different sizes stay structurally identical — same books,
   * same chapters, same heading placement — and differ only in depth. That is
   * what makes a 4k-vs-34k comparison a clean O(N) probe.
   */
  targetCells?: number
  /** Fraction of verse cells carrying target text. Default 0.35. */
  translatedFraction?: number
  /** Fraction of verse cells that are validated. Default 0.1. */
  validatedFraction?: number
  /** PRNG seed. Fixed by default — change it only to prove a result is not seed-specific. */
  seed?: number
}

export interface WholeBibleFixture {
  /** Two rows (source + target) per cell, in display order. */
  rows: CellRow[]
  /** Cell ids in display order. */
  cellIds: string[]
  /** `"GEN 1"`-style chapter labels, in order — navigation jump targets. */
  chapterLabels: string[]
  stats: {
    cells: number
    books: number
    chapters: number
    verses: number
    headings: number
    translated: number
    validated: number
  }
}

/** mulberry32 — small, fast, and deterministic across engines. */
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
  "In the beginning", "and the earth was", "without form and void",
  "and darkness was upon", "the face of the deep", "and the Spirit moved",
  "upon the face of", "the waters and God said", "let there be light",
  "and there was light", "and God saw the light", "that it was good",
]

function sentence(rand: () => number, words: number): string {
  const parts: string[] = []
  for (let i = 0; i < words; i++) parts.push(LOREM[Math.floor(rand() * LOREM.length)])
  return `${parts.join(" ")}.`
}

function makeRow(
  cellId: string,
  side: "source" | "target",
  value: string,
  canonicalRef: string | null,
  type: string | null,
  validated: boolean,
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type,
    canonicalRef,
    anchorCellId: null,
    eventId: `${side}:${cellId}`,
    sourceEventId: side === "target" && value ? `source:${cellId}` : null,
    lastEditor: value ? "tester" : null,
    lastEditAt: value ? 1_700_000_000_000 : 0,
    validated,
    wordCount: value ? value.split(" ").length : 0,
  }
}

/**
 * Build the fixture. Cost is ~O(targetCells); at 34k it runs in well under a
 * second, so tests can build it in a `beforeAll` without a timeout bump.
 */
export function buildWholeBibleFixture(options: WholeBibleFixtureOptions = {}): WholeBibleFixture {
  const {
    targetCells = WHOLE_BIBLE_CELL_COUNT,
    translatedFraction = 0.35,
    validatedFraction = 0.1,
    seed = 1047,
  } = options

  // Headings are structural and fixed by the canon; the remaining budget is
  // spread over chapters. Math.max(1, …) keeps very small fixtures (used to
  // prove the scaling assertions are not vacuous) structurally valid.
  const headings = TOTAL_BOOKS + TOTAL_CHAPTERS
  const verseBudget = Math.max(TOTAL_CHAPTERS, targetCells - headings)
  const versesPerChapter = Math.max(1, Math.floor(verseBudget / TOTAL_CHAPTERS))
  // Integer division leaves a remainder; hand it to the first `extra` chapters
  // so the total lands on `targetCells` exactly rather than approximately.
  let extra = verseBudget - versesPerChapter * TOTAL_CHAPTERS

  const rand = mulberry32(seed)
  const rows: CellRow[] = []
  const cellIds: string[] = []
  const chapterLabels: string[] = []
  let verses = 0
  let translated = 0
  let validated = 0

  const push = (
    cellId: string,
    sourceText: string,
    targetText: string,
    canonicalRef: string | null,
    type: string | null,
    isValidated: boolean,
  ): void => {
    cellIds.push(cellId)
    rows.push(makeRow(cellId, "source", sourceText, canonicalRef, type, false))
    rows.push(makeRow(cellId, "target", targetText, canonicalRef, type, isValidated))
  }

  for (const [book, chapterCount] of CHAPTERS_BY_BOOK) {
    push(`${book}:title`, `The Book of ${book}`, "", null, "heading", false)

    for (let chapter = 1; chapter <= chapterCount; chapter++) {
      const label = `${book} ${chapter}`
      chapterLabels.push(label)
      push(`${book}:${chapter}:heading`, `Chapter ${chapter}`, "", `${book} ${chapter}:0`, "heading", false)

      let verseCount = versesPerChapter
      if (extra > 0) {
        verseCount++
        extra--
      }
      for (let verse = 1; verse <= verseCount; verse++) {
        const cellId = `${book}:${chapter}:${verse}`
        const roll = rand()
        const isTranslated = roll < translatedFraction
        const isValidated = roll < validatedFraction
        push(
          cellId,
          sentence(rand, 8 + Math.floor(rand() * 10)),
          isTranslated ? sentence(rand, 8 + Math.floor(rand() * 10)) : "",
          `${book} ${chapter}:${verse}`,
          null,
          isValidated,
        )
        verses++
        if (isTranslated) translated++
        if (isValidated) validated++
      }
    }
  }

  return {
    rows,
    cellIds,
    chapterLabels,
    stats: {
      cells: cellIds.length,
      books: TOTAL_BOOKS,
      chapters: TOTAL_CHAPTERS,
      verses,
      headings,
      translated,
      validated,
    },
  }
}
