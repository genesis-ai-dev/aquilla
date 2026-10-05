// Candidate chapter seams for timed media (AQU-1388 spike).
//
// A media file that carries no structure of its own is divided into fixed
// 5-minute buckets (`timelineMilestones` in ./milestones.ts). The number is
// arbitrary: a bucket opens mid-sentence as often as not and its label
// ("05:00–10:00") tells an oral translator nothing about what is inside it.
//
// The spike's premise is that Jev can score a media boundary the same way
// AQU-1386 scores a text seam — but Jev reads only text or JSON state, so it
// can neither hear nor see. CANDIDATE SEAMS THEREFORE COME FROM CODE AND JEV
// ONLY SCORES THEM. This module is that deterministic half:
//
//   cues → mediaSeamCandidates()  → the places a chapter could plausibly open
//        → mediaSeamContext()     → the +-30s transcript either side of one
//        → (./media-seam-request.ts asks Jev)
//        → mediaChapters()        → chapters, honouring min/max duration
//
// Deliberately NOT wired into planImportMilestones: the ticket asks for a
// prototype and a recommendation, not a shipped feature. The shipped path is
// AQU-1387, which takes this module's thresholds as its media thresholds.
//
// Same alias-free / DOM-free contract as ../completion/seams.ts, which this
// module reuses: if the chaptering ever moves server-side (it is a background
// job in every option the ticket lists) the worker tsconfigs have no path
// mapping, and a `@/` import added here would only fail there.

import { heuristicJoin } from "../completion/seams"
import type { BoundaryLevel, BoundarySource, ScoredBoundary } from "./ai-sections"
import { MIN_SCORED_COVERAGE, SECTION_BOUNDARY_LEVEL } from "./ai-sections"

/**
 * Must equal `TIMELINE_MILESTONE_MS` in ./milestones.ts — the bucket size this
 * spike is measured against. Duplicated rather than imported because
 * milestones.ts reaches for `@/lib/file-labeling/bible-book-names`, which would
 * drag a path alias into an otherwise alias-free module;
 * media-seams.test.ts pins the two values together so the copy cannot drift.
 */
export const TIMELINE_BUCKET_MS = 5 * 60 * 1000

/**
 * One timed cue, as every media input we have can describe itself: subtitle
 * cues (`extractVttStrings`), ASR chunks (`TranscriptionResult.chunks`, in
 * seconds — convert), or diarized turns. Structural, so no caller has to build
 * an importer type to ask this module a question.
 */
export interface MediaCue {
  /** Stable identity — the unit key at import, the cue id in a prototype run. */
  key: string
  startMs: number
  endMs: number
  text: string
  /** Diarization label or a VTT `<v …>` voice tag. */
  speaker?: string | null
  /** A shot cut lands at this cue's START (ffmpeg scene detection, for video). */
  shotCut?: boolean
  /**
   * Pitch or energy reset at this cue's start, normalized to [0,1]. The
   * cheapest prosody cue the ticket asks about; absent means "not measured",
   * which is NOT the same as zero.
   */
  prosodyReset?: number
}

/** Why a candidate exists. Carried through so the eval can ablate by origin. */
export type MediaSeamReason = "pause" | "speaker" | "shot" | "sentence"

/** The seam AFTER `index`, i.e. between `cues[index]` and `cues[index + 1]`. */
export interface MediaSeamCandidate {
  index: number
  /** Where a chapter opening here would start: the next cue's start time. */
  atMs: number
  /** Silence between the two cues. Negative overlaps clamp to 0. */
  pauseMs: number
  speakerChange: boolean
  shotCut: boolean
  /** null = not measured. */
  prosodyReset: number | null
  /** The previous cue ends on sentence-final punctuation. */
  sentenceFinal: boolean
  reasons: MediaSeamReason[]
}

export interface MediaSeamOptions {
  /** A pause at or above this is a candidate on its own. */
  minPauseMs: number
  /** A sentence-final cue needs only this much silence to be a candidate. */
  sentencePauseMs: number
}

/**
 * PROVISIONAL, exactly like `DEFAULT_SEAM_THRESHOLDS`: read speech pauses
 * roughly 200-500ms between sentences and noticeably longer at a paragraph or
 * pericope, so 600ms is "longer than a sentence break" and 250ms is "a real
 * stop, not a breath". Both numbers are what the eval
 * (`scripts/media-chapters-eval.ts`) exists to replace with measured ones —
 * they are candidate RECALL knobs, so being generous here costs Jev calls,
 * while being mean costs boundaries no amount of scoring can recover.
 */
export const DEFAULT_MEDIA_SEAM_OPTIONS: MediaSeamOptions = {
  minPauseMs: 600,
  sentencePauseMs: 250,
}

/**
 * Every place a chapter could plausibly open, in cue order.
 *
 * Union, not intersection: a shot cut with no pause and a long pause with no
 * shot cut are both real openings, and a candidate Jev never sees is a
 * boundary it cannot find. Scoring culls; this stage must not.
 */
export function mediaSeamCandidates(
  cues: readonly MediaCue[],
  options: MediaSeamOptions = DEFAULT_MEDIA_SEAM_OPTIONS,
): MediaSeamCandidate[] {
  const candidates: MediaSeamCandidate[] = []

  for (let index = 0; index < cues.length - 1; index += 1) {
    const cue = cues[index]
    const next = cues[index + 1]
    const pauseMs = Math.max(0, next.startMs - cue.endMs)
    const speakerChange = Boolean(cue.speaker && next.speaker && cue.speaker !== next.speaker)
    const shotCut = next.shotCut === true
    // `heuristicJoin` is AQU-1386's shipped punctuation rule ("does the
    // sentence run on?"), inverted. One definition of sentence-final, so the
    // text and media paths can never disagree about what a full stop is.
    const sentenceFinal = !heuristicJoin(cue.text)

    const reasons: MediaSeamReason[] = []
    if (pauseMs >= options.minPauseMs) reasons.push("pause")
    if (speakerChange) reasons.push("speaker")
    if (shotCut) reasons.push("shot")
    if (sentenceFinal && pauseMs >= options.sentencePauseMs) reasons.push("sentence")
    if (reasons.length === 0) continue

    candidates.push({
      index,
      atMs: next.startMs,
      pauseMs,
      speakerChange,
      shotCut,
      prosodyReset: typeof next.prosodyReset === "number" ? next.prosodyReset : null,
      sentenceFinal,
      reasons,
    })
  }

  return candidates
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** The transcript either side of a candidate, as Jev will read it. */
export interface MediaSeamContext {
  beforeText: string
  afterText: string
}

/** How much transcript to put either side of a candidate. The ticket's "about
 *  30 s either side"; the eval varies it, which is why it is an argument. */
export const DEFAULT_CONTEXT_MS = 30_000

/**
 * Transcript for `contextMs` either side of a candidate.
 *
 * Whole cues only, and at least one cue on each side however short the window:
 * a boundary question with an empty side is unanswerable, and half a cue reads
 * as a mid-sentence truncation the model would then explain rather than score.
 */
export function mediaSeamContext(
  cues: readonly MediaCue[],
  candidate: MediaSeamCandidate,
  contextMs: number = DEFAULT_CONTEXT_MS,
): MediaSeamContext {
  const before: string[] = []
  const boundaryEnd = cues[candidate.index].endMs
  for (let index = candidate.index; index >= 0; index -= 1) {
    if (before.length > 0 && boundaryEnd - cues[index].startMs > contextMs) break
    before.unshift(cues[index].text.trim())
  }

  const after: string[] = []
  const boundaryStart = candidate.atMs
  for (let index = candidate.index + 1; index < cues.length; index += 1) {
    if (after.length > 0 && cues[index].endMs - boundaryStart > contextMs) break
    after.push(cues[index].text.trim())
  }

  return {
    beforeText: before.filter(Boolean).join(" "),
    afterText: after.filter(Boolean).join(" "),
  }
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

export interface MediaChapter {
  /** Positional and stable across a re-run of the same cues. */
  key: string
  startMs: number
  endMs: number
  /** Inclusive cue range. */
  startCueIndex: number
  endCueIndex: number
}

export interface MediaChapterOptions {
  /** Level at or above which a scored candidate opens a chapter. */
  sectionLevel: BoundaryLevel
  /** A chapter shorter than this is merged back into its predecessor. */
  minChapterMs: number
  /** A chapter longer than this is split at its strongest interior candidate. */
  maxChapterMs: number
  /**
   * Fraction of candidates that must carry a level before the chaptering is
   * trusted at all. Below it `mediaChapters` returns null, and the caller keeps
   * today's 5-minute buckets — AQU-1387's "no scores, no change" rule, which
   * matters more here because the scorer is a background job that can be off,
   * down, or mid-run while a translator is already navigating the file.
   */
  minScoredCoverage: number
}

/**
 * PROVISIONAL. The min/max are the oral-translation working unit the ticket
 * asks the spike to recommend: shorter than ~90s is not worth navigating to,
 * longer than ~12 min is not a passage anyone works through in one sitting.
 * Both bracket the 5-minute bucket they replace, on purpose — a recommendation
 * that moved the typical unit as well as its boundaries would confound the one
 * question being asked.
 */
export const DEFAULT_MEDIA_CHAPTER_OPTIONS: MediaChapterOptions = {
  sectionLevel: SECTION_BOUNDARY_LEVEL,
  minChapterMs: 90_000,
  maxChapterMs: 12 * 60_000,
  // AQU-1387's number, deliberately not a media-specific one: how much of a
  // file must be scored before its divisions are trusted is a question about
  // the background job, which is the same job for both.
  minScoredCoverage: MIN_SCORED_COVERAGE,
}

/** Strength used to pick between competing candidates: level first, then the
 *  longest pause. Deterministic, so two runs over the same cues agree. */
function strength(candidate: MediaSeamCandidate, scored: ScoredBoundary | undefined): number {
  return (scored?.level ?? 0) * 1_000_000 + Math.min(999_999, candidate.pauseMs)
}

/**
 * Chapters from scored candidates.
 *
 * `levels(candidateIndex)` is AQU-1386's `BoundarySource` with the candidate's
 * position in `candidates` as its index — the same cached answers, thresholded
 * at a different level, which is the whole reason the seam scorer is a shared
 * module rather than a drafting-private helper.
 *
 * Returns null when coverage is too thin — "keep what you were doing", the
 * same signal `planAiSections` gives, and NOT an empty list, which a caller
 * could reasonably render as a file with no chapters at all.
 */
export function mediaChapters(
  cues: readonly MediaCue[],
  candidates: readonly MediaSeamCandidate[],
  levels: BoundarySource,
  options: MediaChapterOptions = DEFAULT_MEDIA_CHAPTER_OPTIONS,
): MediaChapter[] | null {
  if (cues.length === 0) return null

  const scored = candidates.map((_, index) => levels(index))
  const covered = scored.filter((entry) => entry !== undefined).length
  if (candidates.length === 0 || covered / candidates.length < options.minScoredCoverage) return null

  const opening = candidates
    .map((candidate, position) => ({ candidate, scored: scored[position] }))
    .filter((entry) => (entry.scored?.level ?? 0) >= options.sectionLevel)

  // Merge away anything too short, keeping the stronger of the two cuts that
  // bracket the short chapter. Dropping the LATER one unconditionally would let
  // a weak cut at 00:10 suppress the real chapter opening at 01:00.
  const cuts: { candidate: MediaSeamCandidate; scored: ScoredBoundary | undefined }[] = []
  for (const entry of opening) {
    const previous = cuts.at(-1)
    const previousStart = previous ? previous.candidate.atMs : cues[0].startMs
    if (entry.candidate.atMs - previousStart < options.minChapterMs) {
      if (previous && strength(entry.candidate, entry.scored) > strength(previous.candidate, previous.scored)) {
        cuts[cuts.length - 1] = entry
      }
      continue
    }
    cuts.push(entry)
  }

  const indices = cuts.map((entry) => entry.candidate.index)
  const split = enforceMaximum(cues, candidates, scored, indices, options)
  return buildChapters(cues, split)
}

/**
 * Split any chapter over `maxChapterMs` at its strongest interior candidate,
 * recursively — the same weakest/strongest-point bisection
 * `../completion/seams.ts` uses to break an oversize drafting unit, for the
 * same reason: a 16-minute stretch with a clear break at 8 minutes should
 * divide THERE.
 *
 * Ties break toward the middle of the stretch, so an unscored file splits into
 * balanced halves instead of shaving one cue off the front over and over. A
 * split that would leave either side under `minChapterMs` is preferred against,
 * and a chapter with no interior candidate at all is LEFT LONG rather than cut
 * at an arbitrary time — reintroducing a fixed-size division inside a chapter
 * would be the mistake this replaces, one level down. Such a chapter is a
 * reportable outcome for the eval, not an error.
 */
function enforceMaximum(
  cues: readonly MediaCue[],
  candidates: readonly MediaSeamCandidate[],
  scored: readonly (ScoredBoundary | undefined)[],
  cutIndices: readonly number[],
  options: MediaChapterOptions,
): number[] {
  const added: number[] = []

  const divide = (startIndex: number, endIndex: number): void => {
    const startMs = cues[startIndex].startMs
    const endMs = cues[endIndex].endMs
    if (endMs - startMs <= options.maxChapterMs) return

    const midMs = (startMs + endMs) / 2
    let best: { index: number; score: number; distance: number; fits: boolean } | undefined
    for (let position = 0; position < candidates.length; position += 1) {
      const candidate = candidates[position]
      if (candidate.index < startIndex || candidate.index >= endIndex) continue
      const score = strength(candidate, scored[position])
      const distance = Math.abs(candidate.atMs - midMs)
      const fits =
        candidate.atMs - startMs >= options.minChapterMs
        && endMs - candidate.atMs >= options.minChapterMs
      const better = !best
        || (fits !== best.fits ? fits : (score !== best.score ? score > best.score : distance < best.distance))
      if (better) best = { index: candidate.index, score, distance, fits }
    }
    if (!best) return

    added.push(best.index)
    divide(startIndex, best.index)
    divide(best.index + 1, endIndex)
  }

  const bounds = [-1, ...cutIndices, cues.length - 1]
  for (let section = 0; section < bounds.length - 1; section += 1) {
    divide(bounds[section] + 1, bounds[section + 1])
  }

  return [...cutIndices, ...added].sort((left, right) => left - right)
}

function buildChapters(cues: readonly MediaCue[], cutIndices: readonly number[]): MediaChapter[] {
  const bounds = [-1, ...cutIndices, cues.length - 1]
  const chapters: MediaChapter[] = []
  for (let section = 0; section < bounds.length - 1; section += 1) {
    const startCueIndex = bounds[section] + 1
    const endCueIndex = bounds[section + 1]
    if (endCueIndex < startCueIndex) continue
    chapters.push({
      key: `media-chapter:${cues[startCueIndex].key}`,
      startMs: cues[startCueIndex].startMs,
      endMs: cues[endCueIndex].endMs,
      startCueIndex,
      endCueIndex,
    })
  }
  return chapters
}

/**
 * The bar: chapters exactly where today's 5-minute buckets fall.
 *
 * Built from the same cues so the eval compares two divisions of one timeline
 * rather than a division against a clock — a cue straddling a bucket edge
 * belongs to the bucket its START is in, which is what `timelineMilestones`
 * does with `Math.floor(startMs / TIMELINE_MILESTONE_MS)`.
 */
export function timeBucketChapters(
  cues: readonly MediaCue[],
  bucketMs: number = TIMELINE_BUCKET_MS,
): MediaChapter[] {
  if (cues.length === 0 || bucketMs <= 0) return []
  const cutIndices: number[] = []
  for (let index = 1; index < cues.length; index += 1) {
    const previousBucket = Math.floor(cues[index - 1].startMs / bucketMs)
    const bucket = Math.floor(cues[index].startMs / bucketMs)
    if (bucket !== previousBucket) cutIndices.push(index - 1)
  }
  return buildChapters(cues, cutIndices)
}

/** Chapter opening times, excluding the file's own start — every divider gets
 *  the first cue for free, so counting it would flatter all of them. */
export function chapterBoundaryTimes(chapters: readonly MediaChapter[]): number[] {
  return chapters.slice(1).map((chapter) => chapter.startMs)
}
