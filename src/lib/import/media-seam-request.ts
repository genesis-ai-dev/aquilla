// Jev wire format for media chapter candidates (AQU-1388 spike).
//
// Split from ./media-seams.ts for the same reason ../completion/seam-request.ts
// is split from ../completion/seams.ts: the DECISION rule is product logic we
// argue about, the WIRE SHAPE is an upstream contract we merely conform to.
//
// What is borrowed from AQU-1386 and what is new:
//   - borrowed verbatim: the model pin, the endpoint, the batch cap, and the
//     `boundary_level` score question WITH ITS CRITERIA. The spike's whole
//     premise is that the same 0-4 question transfers to media, so asking a
//     reworded one would measure a different classifier.
//   - new: three atomic booleans the ticket names (`topic_shift`, `new_scene`,
//     `speaker_turn_is_new_segment`). Jev's published guidance — one broad
//     question scores far worse than several narrow ones combined in code — is
//     why they are separate questions and why `combineMediaSeam` does the
//     combining here, where it is testable.
//   - new: the STATE, which is the spike's actual subject. Jev cannot hear or
//     see, so `MEDIA_REPRESENTATIONS` enumerates what we put in front of it and
//     the eval ablates them.
//
// Same alias-free / DOM-free contract as ./media-seams.ts.

import type { ScoredBoundary, BoundaryLevel } from "./ai-sections"
import {
  BOUNDARY_LEVEL_CRITERIA,
  JEV_DECISIONS_URL,
  JEV_MODEL,
  MAX_SEAMS_PER_REQUEST,
  type JevQuestion,
} from "../completion/seam-request"
import { BOUNDARY_LEVEL_QUESTION } from "../completion/seams"
import { mediaSeamContext, type MediaCue, type MediaSeamCandidate } from "./media-seams"

export { JEV_DECISIONS_URL, JEV_MODEL, MAX_SEAMS_PER_REQUEST }

/** One candidate per question group, so the batch cap is the candidate cap. */
export const MAX_CANDIDATES_PER_REQUEST = MAX_SEAMS_PER_REQUEST

// ---------------------------------------------------------------------------
// Representations — the thing being ablated
// ---------------------------------------------------------------------------

export type MediaSeamFeature = "pause" | "speaker" | "shot" | "prosody"

/**
 * The ticket's ablation (a)-(e), cumulative. `a` is transcript only: the
 * control that says whether any of the signal Jev cannot perceive is worth
 * serializing for it. If `a` wins, media chaptering is a text problem and
 * AQU-1387 already solves it.
 */
export const MEDIA_REPRESENTATIONS: Record<string, readonly MediaSeamFeature[]> = {
  a: [],
  b: ["pause"],
  c: ["pause", "speaker"],
  d: ["pause", "speaker", "shot"],
  e: ["pause", "speaker", "shot", "prosody"],
}

/** Every feature. The richest state, for a prototype run that is not ablating. */
export const ALL_MEDIA_FEATURES: readonly MediaSeamFeature[] = MEDIA_REPRESENTATIONS.e

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

export type MediaSeamQuestionKey =
  | "topic_shift"
  | "new_scene"
  | "speaker_turn_is_new_segment"

export interface MediaSeamQuestion {
  key: MediaSeamQuestionKey
  question: string
  criteria: { true: string; false: string }
}

/**
 * Narrow and non-overlapping, as the booleans in ../completion/seams.ts are.
 * `speaker_turn_is_new_segment` is the veto that stops a dialogue exchange from
 * being chaptered every time the speaker changes — diarization makes speaker
 * changes the most abundant candidate we generate, so without it a two-voice
 * recording would be chaptered to pieces.
 */
export const MEDIA_SEAM_QUESTIONS: readonly MediaSeamQuestion[] = [
  {
    key: "topic_shift",
    question: "Does the material AFTER the boundary move to a different topic, episode, or passage?",
    criteria: {
      true: "`after` starts talking about something `before` had finished with.",
      false: "`after` continues the same topic or episode as `before`.",
    },
  },
  {
    key: "new_scene",
    question: "Does a new scene, setting, or section of the recording begin after the boundary?",
    criteria: {
      true: "`after` opens a new scene, setting, or named section.",
      false: "`after` stays in the same scene and setting as `before`.",
    },
  },
  {
    key: "speaker_turn_is_new_segment",
    question:
      "If the speaker changes at this boundary, does that change start a new segment rather than continue one conversation?",
    criteria: {
      true: "The new voice begins separate material (a new narrator, reader, or section).",
      false: "The voices are taking turns inside one conversation or reading.",
    },
  },
]

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** One candidate as the model sees it. Field names are snake_case because they
 *  are wire keys the model reads, not TypeScript the app reads. */
export interface MediaCandidateState {
  index: number
  /** Clock time of the boundary, for the model's own sense of pacing. */
  at: string
  before: string
  after: string
  pause_ms?: number
  speaker_change?: boolean
  speaker_before?: string
  speaker_after?: string
  shot_cut?: boolean
  prosody_reset?: number
}

export interface JevMediaRequest {
  model: string
  state: { candidates: MediaCandidateState[] }
  questions: Record<string, JevQuestion>
}

/** Question id for candidate `position` in this request. Answers come back
 *  under the same ids, so this is the only place the mapping is defined. */
export function mediaQuestionId(position: number, key: string): string {
  return `m${position}_${key}`
}

export function formatClock(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
  return hours > 0 ? `${hours}:${base}` : base
}

export interface MediaRequestOptions {
  features?: readonly MediaSeamFeature[]
  contextMs?: number
  model?: string
}

/**
 * Build ONE request covering a window of candidates.
 *
 * Throws past the cap rather than truncating, exactly as `buildSeamRequest`
 * does: a caller that silently loses half its candidates ships a file that is
 * half chaptered and half bucketed, and nothing in the output says which.
 */
export function buildMediaSeamRequest(
  cues: readonly MediaCue[],
  candidates: readonly MediaSeamCandidate[],
  options: MediaRequestOptions = {},
): JevMediaRequest {
  if (candidates.length > MAX_CANDIDATES_PER_REQUEST) {
    throw new RangeError(
      `media window of ${candidates.length} exceeds MAX_CANDIDATES_PER_REQUEST (${MAX_CANDIDATES_PER_REQUEST})`,
    )
  }
  const features = options.features ?? ALL_MEDIA_FEATURES
  const includes = (feature: MediaSeamFeature) => features.includes(feature)

  const state = {
    candidates: candidates.map((candidate, position): MediaCandidateState => {
      const { beforeText, afterText } = mediaSeamContext(cues, candidate, options.contextMs)
      const speakerBefore = cues[candidate.index].speaker
      const speakerAfter = cues[candidate.index + 1]?.speaker
      return {
        index: position,
        at: formatClock(candidate.atMs),
        before: beforeText,
        after: afterText,
        ...(includes("pause") ? { pause_ms: candidate.pauseMs } : {}),
        ...(includes("speaker")
          ? {
              speaker_change: candidate.speakerChange,
              ...(speakerBefore ? { speaker_before: speakerBefore } : {}),
              ...(speakerAfter ? { speaker_after: speakerAfter } : {}),
            }
          : {}),
        ...(includes("shot") ? { shot_cut: candidate.shotCut } : {}),
        ...(includes("prosody") && candidate.prosodyReset !== null
          ? { prosody_reset: candidate.prosodyReset }
          : {}),
      }
    }),
  }

  const questions: Record<string, JevQuestion> = {}
  for (let position = 0; position < candidates.length; position += 1) {
    const subject = { candidate: `candidate ${position}` }
    for (const question of MEDIA_SEAM_QUESTIONS) {
      // A question about a signal the representation withholds would be
      // answered from the transcript alone and read as if it were evidence.
      if (question.key === "speaker_turn_is_new_segment" && !includes("speaker")) continue
      questions[mediaQuestionId(position, question.key)] = {
        type: "noul",
        instructions: { ...subject, question: question.question },
        criteria: question.criteria,
      }
    }
    questions[mediaQuestionId(position, BOUNDARY_LEVEL_QUESTION.key)] = {
      type: "score",
      instructions: { ...subject, question: BOUNDARY_LEVEL_QUESTION.question },
      criteria: [...BOUNDARY_LEVEL_CRITERIA],
    }
  }

  return { model: options.model ?? JEV_MODEL, state, questions }
}

/** Candidates split into windows no larger than the batch cap, in order. */
export function mediaSeamWindows(
  candidates: readonly MediaSeamCandidate[],
  size: number = MAX_CANDIDATES_PER_REQUEST,
): MediaSeamCandidate[][] {
  if (size <= 0) return []
  const windows: MediaSeamCandidate[][] = []
  for (let start = 0; start < candidates.length; start += size) {
    windows.push(candidates.slice(start, start + size))
  }
  return windows
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export interface MediaSeamAnswers {
  topic_shift?: number
  new_scene?: number
  speaker_turn_is_new_segment?: number
  boundary_level?: { level: number; confidence?: number; distribution?: number[] }
}

function noulValue(answer: unknown): number | undefined {
  if (!answer || typeof answer !== "object") return undefined
  const value = (answer as { noul?: unknown }).noul
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function scoreAnswer(answer: unknown): MediaSeamAnswers["boundary_level"] {
  if (!answer || typeof answer !== "object") return undefined
  const typed = answer as { score?: unknown; confidence?: unknown; probabilities?: unknown }
  if (typeof typed.score !== "number" || !Number.isFinite(typed.score)) return undefined

  let distribution: number[] | undefined
  if (typed.probabilities && typeof typed.probabilities === "object") {
    const probabilities = typed.probabilities as Record<string, unknown>
    distribution = BOUNDARY_LEVEL_CRITERIA.map((_, level) => {
      const value = probabilities[String(level)]
      return typeof value === "number" && Number.isFinite(value) ? value : 0
    })
  }
  const confidence =
    typeof typed.confidence === "number" && Number.isFinite(typed.confidence)
      ? typed.confidence
      : undefined
  return {
    level: typed.score,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(distribution ? { distribution } : {}),
  }
}

/** Demux one response into per-candidate answers, in window order. A missing
 *  or malformed candidate is null, never an error: `combineMediaSeam` falls
 *  back to the deterministic rule for that one candidate and the rest stand. */
export function parseMediaSeamAnswers(
  body: unknown,
  candidateCount: number,
): (MediaSeamAnswers | null)[] {
  const answers =
    body && typeof body === "object"
      ? ((body as { answers?: unknown }).answers as Record<string, unknown> | undefined)
      : undefined

  const parsed: (MediaSeamAnswers | null)[] = []
  for (let position = 0; position < candidateCount; position += 1) {
    if (!answers) {
      parsed.push(null)
      continue
    }
    const candidate: MediaSeamAnswers = {}
    let any = false
    for (const question of MEDIA_SEAM_QUESTIONS) {
      const value = noulValue(answers[mediaQuestionId(position, question.key)])
      if (value !== undefined) {
        candidate[question.key] = value
        any = true
      }
    }
    const level = scoreAnswer(answers[mediaQuestionId(position, BOUNDARY_LEVEL_QUESTION.key)])
    if (level) {
      candidate.boundary_level = level
      any = true
    }
    parsed.push(any ? candidate : null)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// The combine rule
// ---------------------------------------------------------------------------

export interface MediaSeamThresholds {
  /** A boolean at or above this counts as true. */
  assert: number
  /** Below this the model's level is discarded for the deterministic rule. */
  confidence: number
}

/**
 * PROVISIONAL, and the numbers the eval exists to settle. 0.5 is the neutral
 * point; 0.4 confidence is AQU-1386's gate, kept identical so a difference
 * between the text and media results is a difference in the STATE rather than
 * in how severely each path second-guesses the model.
 */
export const DEFAULT_MEDIA_THRESHOLDS: MediaSeamThresholds = {
  assert: 0.5,
  confidence: 0.4,
}

function clampLevel(value: number): BoundaryLevel | null {
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < 0 || rounded > 4) return null
  return rounded as BoundaryLevel
}

/**
 * The deterministic fallback, used whenever the model is unavailable, silent,
 * or under the confidence gate. Its job is to be never worse than today — today
 * a boundary is decided by `Math.floor(startMs / 300000)`, which knows nothing
 * about the recording at all.
 *
 * A shot cut or a speaker change with a long pause reads as a section; a long
 * pause alone reads as a paragraph; anything else is a sentence break.
 */
export function heuristicMediaLevel(
  candidate: MediaSeamCandidate,
  longPauseMs = 1_500,
): BoundaryLevel {
  const longPause = candidate.pauseMs >= longPauseMs
  if (candidate.shotCut && longPause) return 4
  if (candidate.speakerChange && longPause) return 4
  if (longPause) return 3
  if (candidate.pauseMs >= 600 && candidate.sentenceFinal) return 2
  return 1
}

export interface MediaBoundary extends ScoredBoundary {
  level: BoundaryLevel
}

/**
 * Combine one candidate's answers into a level.
 *
 * The rule:
 *   level = the model's own 0-4 score, PROMOTED to 4 when `topic_shift` and
 *   `new_scene` are both asserted, and DEMOTED to 2 when the only structural
 *   signal is a speaker change the model says is part of one conversation.
 *
 * Promotion exists because the score question is shared with text, where a
 * "chapter-level topic" has visible headings to anchor it; a recording has
 * none, so the two booleans are how a section announces itself. Demotion is the
 * veto described on `MEDIA_SEAM_QUESTIONS`. Both are argued-about product logic
 * and are pinned by tests, which is the point of combining here rather than in
 * a prompt.
 */
export function combineMediaSeam(
  answers: MediaSeamAnswers | null | undefined,
  candidate: MediaSeamCandidate,
  thresholds: MediaSeamThresholds = DEFAULT_MEDIA_THRESHOLDS,
): MediaBoundary {
  const fallback = (): MediaBoundary => ({
    level: heuristicMediaLevel(candidate),
    decidedBy: "heuristic",
  })
  if (!answers) return fallback()

  const scored = answers.boundary_level
  const level = scored ? clampLevel(scored.level) : null
  if (level === null) return fallback()
  if (scored?.confidence !== undefined && scored.confidence < thresholds.confidence) {
    return fallback()
  }

  const asserted = (value: number | undefined) =>
    typeof value === "number" && value >= thresholds.assert

  let combined: BoundaryLevel = level
  if (asserted(answers.topic_shift) && asserted(answers.new_scene)) combined = 4

  const speakerOnly =
    candidate.speakerChange
    && !candidate.shotCut
    && candidate.reasons.every((reason) => reason === "speaker")
  if (
    speakerOnly
    && answers.speaker_turn_is_new_segment !== undefined
    && !asserted(answers.speaker_turn_is_new_segment)
  ) {
    combined = Math.min(combined, 2) as BoundaryLevel
  }

  return {
    level: combined,
    ...(scored?.confidence !== undefined ? { confidence: scored.confidence } : {}),
    decidedBy: "model",
  }
}
