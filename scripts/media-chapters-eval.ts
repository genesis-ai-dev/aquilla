// Eval harness for media chaptering (AQU-1388).
//
//   pnpm media:chapters:eval                        # baselines, no key needed
//   pnpm media:chapters:eval --cues labelled.json   # a REAL labelled media file
//   pnpm media:chapters:eval --levels dump.json     # add the model's rows
//   pnpm media:chapters:eval --live                 # call Jev per representation
//
// WHAT THIS IS AND IS NOT. The ticket asks for an eval table of
// representation x dataset x F1 x cost. This is the instrument for it. The
// table it prints by default is NOT that answer, and says so at the top of its
// own output, because the two things the answer needs are not in this
// repository:
//
//   1. A LABELLED MEDIA FILE. The ticket names three candidate sources (ETEN
//      audio Bibles with verse timings, Come & See VTT with scene structure,
//      podcast chapter markers). None is checked in, and none can be invented:
//      a track whose pauses we synthesize would rank the pause feature against
//      our own assumption about where readers pause, not against a reader.
//      `--cues` is where that file goes, and the table is real from then on.
//   2. A KEY. Jev needs OPENROUTER_API_KEY (or TYPESAFE_API_KEY), exactly as
//      scripts/seam-eval.ts does. `--levels` takes a dumped level set for
//      environments that have the data but not the key.
//
// What the default dataset DOES measure is worth having on its own: the
// five-minute bucket baseline. Bucket edges depend only on a track's duration,
// so modelling the timing of real scripture text at a read-aloud rate gives a
// defensible number for how often today's division lands on a real section
// boundary — the bar anything here has to clear. Every other default row is
// marked `modelled`, and a modelled row is a plumbing check, not a result.
//
// Truth labels come from the same CC0 OpenBible section-counts dataset
// scripts/ai-sections-eval.ts uses: where 5 or more of 20 published
// translations open a section, that is a boundary. Twenty editorial teams are
// a better label than anything we could write.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { SECTION_BOUNDARIES_CC0 } from "../src/lib/import/data/section-boundaries"
import { parseSectionBoundaries } from "../src/lib/import/section-boundaries"
import { PASSAGE_MIN_TRANSLATIONS, parseVerseRef } from "../src/lib/import/passages"
import {
  chapterBoundaryTimes,
  mediaChapters,
  mediaSeamCandidates,
  timeBucketChapters,
  type MediaCue,
  type MediaSeamCandidate,
} from "../src/lib/import/media-seams"
import {
  ALL_MEDIA_FEATURES,
  JEV_DECISIONS_URL,
  JEV_MODEL,
  MAX_CANDIDATES_PER_REQUEST,
  MEDIA_REPRESENTATIONS,
  buildMediaSeamRequest,
  combineMediaSeam,
  formatClock,
  mediaSeamWindows,
  parseMediaSeamAnswers,
  type MediaSeamAnswers,
  type MediaSeamFeature,
} from "../src/lib/import/media-seam-request"
import type { BoundaryLevel } from "../src/lib/import/ai-sections"
import { scoreBoundaryTimes } from "./lib/boundary-f1"

/** The ticket's two tolerances: a chapter opening 3 s out is indistinguishable
 *  to a listener, and 10 s out is still a usable navigation target. */
const TOLERANCES_MS = [3_000, 10_000]

/** Measured in AQU-1386: about $0.00003 for one batched decision call. */
const USD_PER_CALL = 0.00003

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

interface Dataset {
  id: string
  provenance: string
  /** True when the cue times were MODELLED rather than measured from media. */
  modelled: boolean
  cues: MediaCue[]
  truthMs: number[]
}

/**
 * Read-aloud pacing, used only to lay real text on a timeline so the bucket
 * baseline has a duration to divide. 150 wpm is the middle of the published
 * range for narrated scripture; the pauses are punctuation-derived and
 * deliberately know nothing about where a section begins, so no feature can
 * read the answer key out of the timing.
 */
const MS_PER_WORD = 60_000 / 150
const SENTENCE_PAUSE_MS = 400
const CLAUSE_PAUSE_MS = 150
const SENTENCE_FINAL = /[.!?;:։۔؟।॥。！？]["'”’»›）)\]}」』\s]*$/u

function modelledScriptureDatasets(path: string): Dataset[] {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as {
    documents: { id: string; kind: string; provenance: string; cells: { key: string; text: string; ref?: string }[] }[]
  }
  const sections = parseSectionBoundaries(SECTION_BOUNDARIES_CC0)

  return fixture.documents
    .filter((document) => document.kind === "scripture")
    .map((document) => {
      const cues: MediaCue[] = []
      const truthMs: number[] = []
      let at = 0
      for (const cell of document.cells) {
        const words = cell.text.trim().split(/\s+/).filter(Boolean).length
        const durationMs = Math.max(1_000, Math.round(words * MS_PER_WORD))
        const cue: MediaCue = {
          key: cell.key,
          startMs: at,
          endMs: at + durationMs,
          text: cell.text,
        }
        cues.push(cue)
        at = cue.endMs + (SENTENCE_FINAL.test(cell.text.trim()) ? SENTENCE_PAUSE_MS : CLAUSE_PAUSE_MS)

        const ref = parseVerseRef(cell.ref)
        if (!ref || cues.length === 1) continue
        const strength = sections.strengthAt(ref.book, ref.chapter, ref.verse) ?? 0
        if (strength >= PASSAGE_MIN_TRANSLATIONS) truthMs.push(cue.startMs)
      }
      return {
        id: `${document.id} (modelled timing)`,
        provenance: document.provenance,
        modelled: true,
        cues,
        truthMs,
      }
    })
}

/** A real labelled media file: `{ documents: [{ id, provenance?, cues, truthMs }] }`. */
function labelledDatasets(path: string): Dataset[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    documents?: { id: string; provenance?: string; cues: MediaCue[]; truthMs: number[] }[]
  }
  if (!Array.isArray(parsed.documents)) {
    throw new Error(`${path}: expected { "documents": [{ "cues": [...], "truthMs": [...] }] }`)
  }
  return parsed.documents.map((document) => ({
    id: document.id,
    provenance: document.provenance ?? path,
    modelled: false,
    cues: document.cues,
    truthMs: document.truthMs,
  }))
}

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

type Levels = (candidateIndex: number) => BoundaryLevel | undefined

interface Row {
  dataset: string
  scorer: string
  modelled: boolean
  truth: number
  predicted: number
  f1: number[]
  calls: number
}

function chapterTimes(
  cues: readonly MediaCue[],
  candidates: readonly MediaSeamCandidate[],
  levels: Levels,
): number[] | null {
  const chapters = mediaChapters(cues, candidates, (index) => {
    const level = levels(index)
    return level === undefined ? undefined : { level }
  })
  return chapters === null ? null : chapterBoundaryTimes(chapters)
}

function row(
  dataset: Dataset,
  scorer: string,
  predicted: readonly number[] | null,
  calls = 0,
): Row {
  const times = predicted ?? []
  return {
    dataset: dataset.id,
    scorer,
    modelled: dataset.modelled,
    truth: dataset.truthMs.length,
    predicted: times.length,
    f1: TOLERANCES_MS.map((tolerance) => scoreBoundaryTimes(times, dataset.truthMs, tolerance).f1),
    calls,
  }
}

// ---------------------------------------------------------------------------
// Live Jev
// ---------------------------------------------------------------------------

async function liveLevels(
  cues: readonly MediaCue[],
  candidates: readonly MediaSeamCandidate[],
  features: readonly MediaSeamFeature[],
): Promise<{ levels: (BoundaryLevel | undefined)[]; calls: number }> {
  const key = process.env.OPENROUTER_API_KEY || process.env.TYPESAFE_API_KEY
  if (!key) throw new Error("--live needs OPENROUTER_API_KEY or TYPESAFE_API_KEY")
  const url = process.env.JEV_DECISIONS_URL?.trim() || JEV_DECISIONS_URL

  const answers: (MediaSeamAnswers | null)[] = []
  let calls = 0
  for (const window of mediaSeamWindows(candidates)) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildMediaSeamRequest(cues, window, { features })),
    })
    calls += 1
    if (!response.ok) {
      throw new Error(`decisions endpoint ${response.status}: ${await response.text()}`)
    }
    answers.push(...parseMediaSeamAnswers(await response.json(), window.length))
  }
  return {
    levels: candidates.map((candidate, position) =>
      combineMediaSeam(answers[position], candidate).level,
    ),
    calls,
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padStart(6)
}

function table(rows: readonly Row[]): void {
  for (const scorer of [...new Set(rows.map((entry) => entry.scorer))]) {
    const forScorer = rows.filter((entry) => entry.scorer === scorer)
    console.log(`\n${scorer}`)
    for (const entry of forScorer) {
      console.log(
        `  ${entry.dataset.padEnd(32)} ${String(entry.truth).padStart(2)} true`
        + ` ${String(entry.predicted).padStart(2)} predicted`
        + `   F1 +-3s ${percent(entry.f1[0])}  F1 +-10s ${percent(entry.f1[1])}`
        + (entry.modelled ? "   [modelled timing]" : ""),
      )
    }
  }
}

function reportCost(datasets: readonly Dataset[], candidates: number): void {
  const totalMs = datasets.reduce(
    (total, dataset) => total + (dataset.cues.at(-1)!.endMs - dataset.cues[0].startMs),
    0,
  )
  const hours = totalMs / 3_600_000
  const perHour = hours > 0 ? candidates / hours : 0
  const callsPerHour = Math.ceil(perHour / MAX_CANDIDATES_PER_REQUEST)
  console.log(
    `\nprojected cost — ${perHour.toFixed(0)} candidates per hour of media,`
    + ` ${callsPerHour} batched calls at $${USD_PER_CALL} = $${(callsPerHour * USD_PER_CALL).toFixed(5)} per hour`
    + ` (projection from AQU-1386's measured per-call price; nothing here called Jev unless --live says so)`,
  )
}

// ---------------------------------------------------------------------------

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}

const cuesPath = argument("--cues")
const levelsPath = argument("--levels")
const live = process.argv.includes("--live")

const datasets = cuesPath
  ? labelledDatasets(resolve(cuesPath))
  : modelledScriptureDatasets(resolve(import.meta.dirname, "fixtures/ai-sections-eval.json"))

const dump: Record<string, (number | null)[]> | undefined = levelsPath
  ? JSON.parse(readFileSync(resolve(levelsPath), "utf8"))
  : undefined

console.log(
  `AQU-1388 media chaptering eval — boundary F1 at +-3s and +-10s,`
  + ` truth at >= ${PASSAGE_MIN_TRANSLATIONS}/20 translations,`
  + ` model ${live ? JEV_MODEL : "not called"}`,
)
if (!cuesPath) {
  console.log(
    "\nNO LABELLED MEDIA FILE. Cue times below are MODELLED from real scripture"
    + "\ntext at a read-aloud rate, so only the five-minute bucket row — which"
    + "\ndepends on duration alone — is a result. Every other modelled row is a"
    + "\nplumbing check. Pass --cues with an ETEN audio-Bible, Come & See, or"
    + "\nchapter-marked podcast track to make the whole table real.",
  )
}

const rows: Row[] = []
let totalCandidates = 0

for (const dataset of datasets) {
  const candidates = mediaSeamCandidates(dataset.cues)
  totalCandidates += candidates.length

  rows.push(row(
    dataset,
    "baseline — five-minute buckets (what ships today)",
    chapterBoundaryTimes(timeBucketChapters(dataset.cues)),
  ))

  rows.push(row(
    dataset,
    "baseline — deterministic pause/speaker/shot rule",
    chapterTimes(dataset.cues, candidates, (index) =>
      combineMediaSeam(null, candidates[index]).level),
  ))

  for (const [name, features] of Object.entries(MEDIA_REPRESENTATIONS)) {
    const label = `(${name}) ${features.length === 0 ? "transcript only" : features.join(" + ")}`
    if (live) {
      const { levels, calls } = await liveLevels(dataset.cues, candidates, features)
      rows.push(row(dataset, `model — ${label}`, chapterTimes(dataset.cues, candidates, (index) => levels[index]), calls))
      continue
    }
    const dumped = dump?.[`${dataset.id}:${name}`] ?? (name === "e" ? dump?.[dataset.id] : undefined)
    if (!dumped) continue
    rows.push(row(dataset, `model — ${label}`, chapterTimes(dataset.cues, candidates, (index) => {
      const level = dumped[index]
      return typeof level === "number" ? (level as BoundaryLevel) : undefined
    })))
  }
}

table(rows)
reportCost(datasets, totalCandidates)

const longest = datasets.reduce(
  (total, dataset) => Math.max(total, dataset.cues.at(-1)!.endMs - dataset.cues[0].startMs),
  0,
)
console.log(
  `\n${datasets.length} dataset(s), ${totalCandidates} candidates,`
  + ` longest track ${formatClock(longest)}.`
  + ` Representations: ${Object.keys(MEDIA_REPRESENTATIONS).join(", ")}`
  + ` (ALL = ${ALL_MEDIA_FEATURES.join(" + ")}).`,
)
if (!live && !dump) {
  console.log(
    "\nNo --live and no --levels dump, so every model row is absent. Dump a"
    + "\nlevel set as { \"<dataset>:<representation>\": [levels…] } to fill them in.",
  )
}
