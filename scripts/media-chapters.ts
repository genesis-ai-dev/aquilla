// Prototype: timed media -> candidate seams -> Jev -> chapters JSON (AQU-1388).
//
//   pnpm media:chapters --file e2e/fixtures/voices-roundtrip.vtt
//   pnpm media:chapters --file track.srt --live --representation e
//   pnpm media:chapters --cues cues.json --out chapters.json
//
// This is the runnable half of the spike's first deliverable. It does NOT
// change what the app imports: `planImportMilestones` still buckets media into
// 5 minutes, and the shipped path is AQU-1387. What this proves is the chain —
// that a real subtitle track yields candidates, that the candidates serialize
// into a Jev request, and that levels coming back produce chapters that respect
// the min/max duration rules.
//
// Without a key it runs the deterministic rule (`heuristicMediaLevel`) so the
// chain is exercisable offline; that output is the FALLBACK, not a model
// result, and the report says which one it printed.
//
// Key: OPENROUTER_API_KEY (OpenRouter's decisions endpoint) or TYPESAFE_API_KEY
// (direct). Endpoint override: JEV_DECISIONS_URL.
//
// `--cues` takes `{ "cues": [{ "key", "startMs", "endMs", "text", "speaker"?,
// "shotCut"?, "prosodyReset"? }] }` — the shape an ASR/diarization/scene-detect
// pass produces, and the input to use for audio, for which this repo has no
// parser of its own.

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { extractSrtStrings, extractVttStrings } from "../src/lib/parsers/subtitle"
import {
  DEFAULT_MEDIA_CHAPTER_OPTIONS,
  chapterBoundaryTimes,
  mediaChapters,
  mediaSeamCandidates,
  timeBucketChapters,
  type MediaChapter,
  type MediaCue,
  type MediaSeamCandidate,
} from "../src/lib/import/media-seams"
import {
  ALL_MEDIA_FEATURES,
  JEV_DECISIONS_URL,
  JEV_MODEL,
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

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Subtitle cue times are seconds on the wire; everything downstream is ms. */
function cuesFromSubtitles(path: string): MediaCue[] {
  const content = readFileSync(path, "utf8")
  const strings = path.toLowerCase().endsWith(".srt")
    ? extractSrtStrings(content)
    : extractVttStrings(content)
  return strings
    .filter((string) => typeof string.start === "number" && typeof string.end === "number")
    .map((string, index) => ({
      key: `cue-${index}`,
      startMs: Math.round((string.start ?? 0) * 1000),
      endMs: Math.round((string.end ?? 0) * 1000),
      text: string.original,
      ...(string.speaker ? { speaker: string.speaker } : {}),
    }))
}

function cuesFromJson(path: string): MediaCue[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { cues?: MediaCue[] }
  if (!Array.isArray(parsed.cues)) throw new Error(`${path}: expected { "cues": [...] }`)
  return parsed.cues
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

interface LevelRun {
  levels: (BoundaryLevel | null)[]
  decidedBy: ("model" | "heuristic")[]
  calls: number
  latencyMs: number
}

function heuristicRun(candidates: readonly MediaSeamCandidate[]): LevelRun {
  const combined = candidates.map((candidate) => combineMediaSeam(null, candidate))
  return {
    levels: combined.map((entry) => entry.level),
    decidedBy: combined.map(() => "heuristic" as const),
    calls: 0,
    latencyMs: 0,
  }
}

async function liveRun(
  cues: readonly MediaCue[],
  candidates: readonly MediaSeamCandidate[],
  features: readonly MediaSeamFeature[],
): Promise<LevelRun> {
  const key = process.env.OPENROUTER_API_KEY || process.env.TYPESAFE_API_KEY
  if (!key) throw new Error("--live needs OPENROUTER_API_KEY or TYPESAFE_API_KEY")
  const url = process.env.JEV_DECISIONS_URL?.trim() || JEV_DECISIONS_URL

  const answers: (MediaSeamAnswers | null)[] = []
  let calls = 0
  let latencyMs = 0
  for (const window of mediaSeamWindows(candidates)) {
    const started = Date.now()
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildMediaSeamRequest(cues, window, { features })),
    })
    latencyMs += Date.now() - started
    calls += 1
    if (!response.ok) {
      throw new Error(`decisions endpoint ${response.status}: ${await response.text()}`)
    }
    answers.push(...parseMediaSeamAnswers(await response.json(), window.length))
  }

  const combined = candidates.map((candidate, position) =>
    combineMediaSeam(answers[position], candidate),
  )
  return {
    levels: combined.map((entry) => entry.level),
    decidedBy: combined.map((entry) => (entry.decidedBy === "model" ? "model" : "heuristic")),
    calls,
    latencyMs,
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function describeChapter(chapter: MediaChapter, cues: readonly MediaCue[]): string {
  const opening = cues[chapter.startCueIndex].text.replace(/\s+/g, " ").trim().slice(0, 60)
  return `${formatClock(chapter.startMs)}-${formatClock(chapter.endMs)}  ${opening}`
}

async function main(): Promise<void> {
  const filePath = argument("--file")
  const cuesPath = argument("--cues")
  if (!filePath && !cuesPath) {
    console.error("usage: pnpm media:chapters --file <track.vtt|.srt> | --cues <cues.json> [--live] [--representation a-e] [--out chapters.json]")
    process.exitCode = 1
    return
  }

  const cues = filePath ? cuesFromSubtitles(resolve(filePath)) : cuesFromJson(resolve(cuesPath!))
  if (cues.length === 0) throw new Error("no timed cues in the input")

  const representation = argument("--representation")
  const features = representation
    ? MEDIA_REPRESENTATIONS[representation] ?? ALL_MEDIA_FEATURES
    : ALL_MEDIA_FEATURES

  const candidates = mediaSeamCandidates(cues)
  const run = flag("--live")
    ? await liveRun(cues, candidates, features)
    : heuristicRun(candidates)

  const chapters = mediaChapters(cues, candidates, (index) => {
    const level = run.levels[index]
    return level === null ? undefined : { level, decidedBy: run.decidedBy[index] }
  })
  const buckets = timeBucketChapters(cues)
  const durationMs = cues[cues.length - 1].endMs - cues[0].startMs

  const output = {
    ticket: "AQU-1388",
    source: filePath ?? cuesPath,
    model: flag("--live") ? JEV_MODEL : null,
    representation: representation ?? "e",
    features,
    durationMs,
    cues: cues.length,
    candidates: candidates.length,
    calls: run.calls,
    latencyMs: run.latencyMs,
    modelDecided: run.decidedBy.filter((entry) => entry === "model").length,
    thresholds: DEFAULT_MEDIA_CHAPTER_OPTIONS,
    chapters,
    bucketBaseline: chapterBoundaryTimes(buckets),
  }

  const outPath = argument("--out")
  if (outPath) {
    writeFileSync(resolve(outPath), `${JSON.stringify(output, null, 2)}\n`)
  } else {
    console.log(JSON.stringify(output, null, 2))
  }

  console.error(
    `\n${formatClock(durationMs)} of media, ${cues.length} cues, ${candidates.length} candidates`
    + ` -> ${chapters ? `${chapters.length} chapters` : "no chapters (coverage too thin; buckets stand)"}`
    + ` against ${buckets.length} five-minute buckets`,
  )
  if (!flag("--live")) {
    console.error(
      "levels came from the DETERMINISTIC rule, not from Jev — pass --live with"
      + "\nOPENROUTER_API_KEY set to get the model's own answer.",
    )
  }
  for (const chapter of chapters ?? []) console.error(`  ${describeChapter(chapter, cues)}`)
}

await main()
