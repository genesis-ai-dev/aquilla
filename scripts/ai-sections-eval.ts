// Shadow eval for AI passage/section boundaries (AQU-1387).
//
//   pnpm ai-sections:eval                       # baselines only (no key needed)
//   pnpm ai-sections:eval -- --levels dump.json # score a real level set
//
// WHY THIS EXISTS. The ticket makes an eval a precondition for turning AI
// sections on: they change what a translator navigates by, and a boundary model
// that is merely plausible would move those divisions around without being
// better than the fixed size it replaced. So this script measures boundary F1
// against labelled data, and the kill switch in
// src/lib/import/ai-sections-flag.ts stays off until the numbers justify
// flipping it.
//
// WHAT IT MEASURES. The PASSAGE layer (level >= 3), because that is the layer
// with ground truth:
//
//   * scripture — the CC0 OpenBible section-counts dataset. Where 5 or more of
//     20 published translations begin a section, that is a passage boundary.
//     Twenty editorial teams are a better label than anything we could write.
//   * prose — the fixture's own headings, STRIPPED from the cell list before
//     scoring so a scorer cannot see the answer it is being graded on.
//
// Boundaries match within +-1 cell: a pericope that opens one verse early is a
// usable suggestion, not a miss. Matching is greedy and one-to-one, so a scorer
// cannot bank one true boundary twice.
//
// WHAT IT CANNOT MEASURE HERE. Jev itself. The classifier route and its cached
// levels live in AQU-1386 (PR #804, not yet on dev), and calling Jev needs a
// server-side key this environment does not have. So `--levels` takes a dumped
// level set instead of reaching for the network: when #804 lands, dump the seam
// cache for these documents and re-run to get the model's row of the table.

import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  PASSAGE_BOUNDARY_LEVEL,
  type BoundaryLevel,
  type BoundarySource,
} from "../src/lib/import/ai-sections"
import {
  PASSAGE_MIN_TRANSLATIONS,
  parseVerseRef,
  suggestPassages,
  type PassagePlanCell,
} from "../src/lib/import/passages"
import { parseSectionBoundaries } from "../src/lib/import/section-boundaries"
import { scoreBoundaries } from "./lib/boundary-f1"
import { SECTION_BOUNDARIES_CC0 } from "../src/lib/import/data/section-boundaries"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(SCRIPT_DIR, "fixtures/ai-sections-eval.json")

/** Cells scored in one upstream call, from AQU-1386's request batching. */
const SEAMS_PER_CALL = 40
/** Measured in AQU-1386: about $0.00003 for one batched decision call. */
const USD_PER_CALL = 0.00003

interface FixtureCell {
  key: string
  text: string
  ref?: string
  heading?: boolean
}

interface FixtureDocument {
  id: string
  kind: "scripture" | "prose"
  provenance: string
  cells: FixtureCell[]
}

interface Scored {
  document: string
  kind: string
  scorer: string
  cells: number
  truth: number
  predicted: number
  precision: number
  recall: number
  f1: number
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

const dataset = parseSectionBoundaries(SECTION_BOUNDARIES_CC0)

/**
 * Indices that genuinely open a passage, excluding index 0 — every scorer gets
 * the file's first cell for free, so counting it would inflate all of them.
 */
function truthBoundaries(document: FixtureDocument, cells: readonly FixtureCell[]): number[] {
  if (document.kind === "scripture") {
    return cells.flatMap((cell, index) => {
      if (index === 0) return []
      const ref = parseVerseRef(cell.ref)
      if (!ref) return []
      const translations = dataset.strengthAt(ref.book, ref.chapter, ref.verse) ?? 0
      return translations >= PASSAGE_MIN_TRANSLATIONS ? [index] : []
    })
  }
  // Prose: the heading itself opens its section.
  return document.cells.flatMap((cell, index) => (cell.heading && index > 0 ? [index] : []))
    .map((headingIndex) => strippedIndexOf(document, headingIndex))
    .filter((index) => index > 0)
}

/**
 * Where a heading's section starts once headings are removed: the first body
 * cell after it. Scoring against the heading's own position would ask a scorer
 * to find a cell that is no longer in its input.
 */
function strippedIndexOf(document: FixtureDocument, headingIndex: number): number {
  let stripped = 0
  for (let index = 0; index < headingIndex; index += 1) {
    if (!document.cells[index].heading) stripped += 1
  }
  return stripped
}

function scorableCells(document: FixtureDocument): FixtureCell[] {
  return document.kind === "prose"
    ? document.cells.filter((cell) => !cell.heading)
    : document.cells
}

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

/**
 * A boundary every `stride` cells — the fixed-size divider this ticket
 * replaces, and therefore the bar. A model that cannot beat it has not earned
 * its call.
 *
 * The stride is the mean true passage length, which is generous: it hands the
 * baseline the right NUMBER of boundaries and asks only whether it can place
 * them.
 */
function fixedStrideLevels(cellCount: number, truth: number): BoundarySource {
  const stride = Math.max(2, Math.round(cellCount / (truth + 1)))
  return (seam) => ({ level: (seam + 1) % stride === 0 ? 4 : 1 })
}

/**
 * Sentence-final punctuation on the previous cell, the deterministic fallback
 * AQU-1386 uses when the model is unavailable. Included because it is the
 * cheapest thing that could possibly work, and because its failure is
 * instructive: nearly every verse ends in a full stop, so it proposes a
 * boundary almost everywhere.
 */
const SENTENCE_FINAL = /[.!?;:։۔؟।॥。！？…]["'”’»›）)\]}」』\s]*$/u

function punctuationLevels(cells: readonly FixtureCell[]): BoundarySource {
  return (seam) => ({
    level: SENTENCE_FINAL.test(cells[seam]?.text ?? "") ? 3 : 0,
  })
}

/** Score a level set dumped from the seam cache: `{ "docId": [levels…] }`. */
function dumpedLevels(
  dump: Record<string, (number | null)[]> | undefined,
  documentId: string,
): BoundarySource | undefined {
  const levels = dump?.[documentId]
  if (!levels) return undefined
  return (seam) => {
    const level = levels[seam]
    return typeof level === "number" ? { level: level as BoundaryLevel } : undefined
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const TOLERANCE = 1

function score(predicted: readonly number[], truth: readonly number[]) {
  const { precision, recall, f1 } = scoreBoundaries(predicted, truth, TOLERANCE)
  return { precision, recall, f1 }
}

function predictedBoundaries(
  cells: readonly FixtureCell[],
  boundaries: BoundarySource,
): number[] {
  const planCells: PassagePlanCell[] = cells.map((cell) => ({
    key: cell.key,
    text: cell.text,
    ...(cell.ref ? { ref: cell.ref } : {}),
  }))
  // Deliberately WITHOUT the section-counts dataset: this measures what the
  // level source alone can find. The dataset is the answer key here, and
  // grading it against itself would report a meaningless 100%.
  const passages = suggestPassages(planCells, boundaries)
  return passages
    .map((passage) => planCells.findIndex((cell) => cell.key === passage.startUnitKey))
    .filter((index) => index > 0)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padStart(6)
}

function table(rows: readonly Scored[]): void {
  const scorers = [...new Set(rows.map((row) => row.scorer))]
  for (const scorer of scorers) {
    const forScorer = rows.filter((row) => row.scorer === scorer)
    console.log(`\n${scorer}`)
    for (const row of forScorer) {
      console.log(
        `  ${row.document.padEnd(18)} ${String(row.cells).padStart(3)} cells`
        + ` ${String(row.truth).padStart(2)} true`
        + ` ${String(row.predicted).padStart(2)} predicted`
        + `   P ${percent(row.precision)}  R ${percent(row.recall)}  F1 ${percent(row.f1)}`,
      )
    }
    const macroF1 = forScorer.reduce((total, row) => total + row.f1, 0) / forScorer.length
    console.log(`  ${"macro F1".padEnd(18)} ${percent(macroF1)}`)
  }
}

function reportCost(cells: number): void {
  // A projection, not a measurement: the per-call price is AQU-1386's measured
  // figure, the call count is this repo's batching. Nothing here called Jev.
  const callsPer1000 = Math.ceil(1000 / SEAMS_PER_CALL)
  console.log(
    `\nprojected cost — ${callsPer1000} batched calls per 1,000 cells`
    + ` at $${USD_PER_CALL} per call = $${(callsPer1000 * USD_PER_CALL).toFixed(5)} per 1,000 cells`
    + ` (${cells} cells in this fixture)`,
  )
}

// ---------------------------------------------------------------------------

const levelsArgument = process.argv.indexOf("--levels")
const dump: Record<string, (number | null)[]> | undefined = levelsArgument > 0
  ? JSON.parse(await readFile(resolve(process.argv[levelsArgument + 1]), "utf8"))
  : undefined

const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as { documents: FixtureDocument[] }
const rows: Scored[] = []
let totalCells = 0

for (const document of fixture.documents) {
  const cells = scorableCells(document)
  const truth = truthBoundaries(document, cells)
  totalCells += cells.length

  const scorers: [string, BoundarySource | undefined][] = [
    ["baseline — fixed stride (what ships today)", fixedStrideLevels(cells.length, truth.length)],
    ["baseline — punctuation heuristic", punctuationLevels(cells)],
    ["model — dumped seam levels", dumpedLevels(dump, document.id)],
  ]

  for (const [scorer, boundaries] of scorers) {
    if (!boundaries) continue
    const predicted = predictedBoundaries(cells, boundaries)
    rows.push({
      document: document.id,
      kind: document.kind,
      scorer,
      cells: cells.length,
      truth: truth.length,
      predicted: predicted.length,
      ...score(predicted, truth),
    })
  }
}

console.log(
  `AQU-1387 passage-boundary eval — level >= ${PASSAGE_BOUNDARY_LEVEL},`
  + ` +-${TOLERANCE}-cell tolerance, scripture truth at`
  + ` >= ${PASSAGE_MIN_TRANSLATIONS}/20 translations`,
)
table(rows)
reportCost(totalCells)

if (!dump) {
  console.log(
    "\nNo --levels dump supplied, so the model row is absent. Jev's own numbers"
    + "\nneed AQU-1386's classifier route (PR #804, not yet on dev) and a"
    + "\nserver-side key: dump the seam cache for these documents and re-run"
    + "\nwith --levels to fill it in. The kill switch stays off until then.",
  )
}
