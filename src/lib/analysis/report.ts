// AQU-1392: the volume-analysis report — the aggregation layer that turns raw
// source text into the TMS-style table a project manager quotes work from.
//
// The pieces below it already existed and are unchanged: `bucketSegments()`
// assigns each segment a document-internal band, `countWords()` counts it
// Matecat-style (CJK per character), `computePayable()` weights the bands.
// What was missing is the thing that joins them per file, rolls them up across
// a project, and hands the result to a table/CSV — this module.
//
// Two rules the numbers depend on, both inherited from `bucketSegments()` and
// re-asserted by this module's tests because a report is only as trustworthy
// as its banding:
//
//   1. Repetition is *document-internal*. A segment repeats only against
//      earlier segments of the SAME file, so a project roll-up is the sum of
//      per-file bands, never a re-bucket of the concatenated project. Two
//      files that happen to share a verse are two `new` segments, which is
//      what a per-file quote has to say.
//   2. The first occurrence is `new`; every later identical one is
//      `repetition`. So `new` counts real work and the discount is honest.
//
// TM/ICE/MT bands have rate slots in `DEFAULT_RATES` but no producer yet
// (AQU-1393 fuzzy matching, AQU-1394 ICE). They are reported at zero and
// listed in `unpopulatedBands` so the UI can say *why* they are zero rather
// than letting a PM read "0 TM words" as "this project has no TM leverage".

import { bucketSegments, type Bucket } from "./buckets"
import { computePayable, DEFAULT_RATES, type PayableBand, type RateTable } from "./payable"
import { countWords } from "./wordcount"

/** Bands a document-internal analysis can actually produce today. */
export const PRODUCED_BANDS: readonly PayableBand[] = ["new", "repetition", "internal_75_99"] as const

/**
 * Bands whose rate exists but whose producer does not yet — reported at zero
 * with a note rather than hidden, so the table matches the rate card.
 */
export const UNPOPULATED_BANDS: readonly PayableBand[] = ["tm_100", "tm_75_99", "ice", "mt"] as const

export type BandTotals = Record<PayableBand, number>

/** A zeroed tally for every band, produced or not. */
export function emptyBandTotals(): BandTotals {
  return { new: 0, repetition: 0, internal_75_99: 0, tm_100: 0, tm_75_99: 0, ice: 0, mt: 0 }
}

/** One file's contribution to the report. */
export interface FileAnalysis {
  fileId: string
  name: string
  segments: number
  words: number
  wordsPerBand: BandTotals
  segmentsPerBand: BandTotals
}

/** One row of the band table as rendered / exported. */
export interface BandRow {
  band: PayableBand
  segments: number
  words: number
  /** Share of the report's total words, 0–100 with one decimal. */
  pctOfWords: number
  rate: number
  payableWords: number
  /** True when no producer can fill this band yet (TM/ICE/MT in v1). */
  unpopulated: boolean
}

export interface AnalysisReport {
  scope: "file" | "project"
  /** File name or project name — what the report is *of*. */
  label: string
  files: FileAnalysis[]
  totalSegments: number
  totalWords: number
  payableWords: number
  /** "Saving on word count", as on a TMS analysis page. */
  discountPct: number
  bands: BandRow[]
  rates: RateTable
}

export interface AnalyzeFileInput {
  fileId: string
  name: string
  /** Source text of every segment, in file order. */
  sources: readonly string[]
}

/**
 * Band one file's source segments. `fuzzyWindow` is passed straight through to
 * `bucketSegments()` — the bounded look-back that keeps the pass O(n·w) on a
 * whole-Bible file instead of quadratic.
 */
export function analyzeFile(input: AnalyzeFileInput, fuzzyWindow?: number): FileAnalysis {
  const bucketed = bucketSegments([...input.sources], fuzzyWindow)
  const wordsPerBand = emptyBandTotals()
  const segmentsPerBand = emptyBandTotals()
  let words = 0
  for (const seg of bucketed) {
    const band: Bucket = seg.bucket
    wordsPerBand[band] += seg.words
    segmentsPerBand[band] += 1
    words += seg.words
  }
  return {
    fileId: input.fileId,
    name: input.name,
    segments: bucketed.length,
    words,
    wordsPerBand,
    segmentsPerBand,
  }
}

function addInto(target: BandTotals, source: BandTotals): void {
  for (const band of Object.keys(target) as PayableBand[]) target[band] += source[band]
}

/**
 * Roll per-file analyses into one report. Summing per-file bands (rather than
 * re-bucketing the concatenation) is deliberate — see rule 1 at the top.
 */
export function buildAnalysisReport(
  files: readonly FileAnalysis[],
  opts: { scope: "file" | "project"; label: string; rates?: RateTable },
): AnalysisReport {
  const rates = opts.rates ?? DEFAULT_RATES
  const words = emptyBandTotals()
  const segments = emptyBandTotals()
  for (const f of files) {
    addInto(words, f.wordsPerBand)
    addInto(segments, f.segmentsPerBand)
  }

  const totalWords = (Object.keys(words) as PayableBand[]).reduce((a, b) => a + words[b], 0)
  const totalSegments = (Object.keys(segments) as PayableBand[]).reduce((a, b) => a + segments[b], 0)
  // `computePayable` drops empty bands, which is right for the weighted total
  // but wrong for a rate card the reader is meant to check — so the totals come
  // from it and the rows are built here, zeros included.
  const payable = computePayable(words, rates)

  const bands: BandRow[] = [...PRODUCED_BANDS, ...UNPOPULATED_BANDS].map((band) => ({
    band,
    segments: segments[band],
    words: words[band],
    pctOfWords: totalWords === 0 ? 0 : Math.round((words[band] / totalWords) * 1000) / 10,
    rate: rates[band],
    payableWords: Math.round(words[band] * rates[band] * 100) / 100,
    unpopulated: UNPOPULATED_BANDS.includes(band),
  }))

  return {
    scope: opts.scope,
    label: opts.label,
    files: [...files],
    totalSegments,
    totalWords,
    payableWords: payable.payableWords,
    discountPct: payable.discountPct,
    bands,
    rates,
  }
}

/** Convenience: analyze a single file and wrap it as a one-file report. */
export function buildFileReport(input: AnalyzeFileInput, fuzzyWindow?: number): AnalysisReport {
  return buildAnalysisReport([analyzeFile(input, fuzzyWindow)], { scope: "file", label: input.name })
}

/** Word count of a single segment — re-exported so callers need one import. */
export { countWords }
