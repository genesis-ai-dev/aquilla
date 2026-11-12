// Jev (TypeSafe System One) wire format for seam classification (AQU-1386).
//
// Split from ./seams.ts so the DECISION rule and the WIRE SHAPE can change
// independently: the combine rule is product logic we argue about, this is an
// upstream contract we merely conform to.
//
// Both auth-worker's /api/v1/ai/seams route and scripts/seam-eval.ts build
// their requests here. That is the point — an eval whose prompts differ from
// production's measures a system nobody ships.
//
// Same alias-free / DOM-free contract as ./prompt-build.ts and ./seams.ts.
//
// Upstream reference: https://docs.typesafe.ai/api.md
//   POST { model, state, questions } → { model, answers, usage }
//   - a `noul` question answers `{ type: "noul", noul: <p(yes)> }` and carries
//     NO confidence field, which is why seams.ts derives certainty from the
//     probability's distance off 0.5;
//   - a `score` question answers `{ score, probabilities, confidence, legend }`.

import {
  BOUNDARY_LEVEL_QUESTION,
  SEAM_QUESTIONS,
  type SeamAnswers,
  type SeamQuestionKey,
} from "./seams"

/**
 * PINNED, never an alias. `jev-latest` would silently re-point the classifier
 * at a model the shadow eval never scored, invalidating the thresholds in
 * DEFAULT_SEAM_THRESHOLDS without anything failing. Bumping this is a code
 * change that re-runs the eval.
 */
export const JEV_MODEL = "typesafe/jev-1.13"

/** Default upstream. OpenRouter fronts the TypeSafe evaluation endpoint, so the
 *  existing server-side OPENROUTER_API_KEY is the only credential needed. */
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"

/**
 * Upper bound on seams per request. Fanning out is cheap — TypeSafe's own
 * parallel-questions study found batching 13 questions into one call 12x
 * cheaper and 10x faster with identical answers — but a whole 1000-cell file in
 * one request is neither cheap nor recoverable when it fails. Callers window.
 */
export const MAX_SEAMS_PER_REQUEST = 40

/** One cell as the model sees it. `ref` and `style` are the verse reference and
 *  block style we already carry; they are what let the model recognise a
 *  heading or an exercise number without guessing from the prose. */
export interface SeamWindowCell {
  id: string
  text: string
  ref?: string | null
  style?: string | null
}

export interface JevNoulQuestion {
  type: "noul"
  instructions: Record<string, unknown>
  criteria?: { true: string; false: string }
}

export interface JevScoreQuestion {
  type: "score"
  instructions: Record<string, unknown>
  criteria: string[]
}

export type JevQuestion = JevNoulQuestion | JevScoreQuestion

export interface JevRequest {
  model: string
  state: { cells: { index: number; ref?: string; style?: string; text: string }[] }
  questions: Record<string, JevQuestion>
}

/**
 * Question id for seam `i` (between window cells i and i+1) and question `key`.
 * Answers come back under the same ids, so this is the only place the mapping
 * between a wire key and a seam index is defined.
 */
export function seamQuestionId(seamIndex: number, key: string): string {
  return `s${seamIndex}_${key}`
}

/** Ordered level descriptions — index IS the boundary level (0–4). */
export const BOUNDARY_LEVEL_CRITERIA: readonly string[] = [
  "The same sentence continues across the boundary.",
  "A new sentence begins, but it is part of the same thought.",
  "A new thought begins within the same paragraph or exercise.",
  "A new paragraph, pericope, or exercise begins.",
  "A new section or chapter-level topic begins.",
]

const NOUL_CRITERIA: Record<SeamQuestionKey, { true: string; false: string }> = {
  continues_sentence: {
    true: "`cell_a` stops mid-sentence and `cell_b` supplies the rest of it.",
    false: "`cell_a` is a complete sentence on its own.",
  },
  same_item: {
    true: "Both cells are parts of one exercise, list item, or dialogue turn.",
    false: "They are separate items.",
  },
  refers_back: {
    true: "`cell_b` opens with a pronoun, connective, or ellipsis that only resolves against `cell_a`.",
    false: "`cell_b` stands on its own.",
  },
  section_break: {
    true: "`cell_b` is a heading, or the first line of a new section or exercise.",
    false: "`cell_b` continues the material `cell_a` belongs to.",
  },
}

function label(index: number): string {
  return `cell ${index}`
}

/**
 * Build ONE request covering every seam in a window.
 *
 * The whole window goes into `state`, and each question names its two cells by
 * the labels used there. That is deliberate: the model sees cells i-1 and i+2
 * around every seam for free, which is the context the ticket asks for, without
 * repeating the text once per question.
 *
 * Throws on a window that exceeds MAX_SEAMS_PER_REQUEST rather than silently
 * truncating — a caller that loses half its seams to a cap it did not know
 * about ships a file that is half classified and half punctuation-guessed.
 */
export function buildSeamRequest(
  cells: readonly SeamWindowCell[],
  model: string = JEV_MODEL,
): JevRequest {
  const seamCount = Math.max(0, cells.length - 1)
  if (seamCount > MAX_SEAMS_PER_REQUEST) {
    throw new RangeError(
      `seam window of ${seamCount} exceeds MAX_SEAMS_PER_REQUEST (${MAX_SEAMS_PER_REQUEST})`,
    )
  }

  const state = {
    cells: cells.map((c, index) => ({
      index,
      ...(c.ref ? { ref: c.ref } : {}),
      ...(c.style ? { style: c.style } : {}),
      text: c.text,
    })),
  }

  const questions: Record<string, JevQuestion> = {}
  for (let i = 0; i < seamCount; i++) {
    const cellA = label(i)
    const cellB = label(i + 1)
    for (const q of SEAM_QUESTIONS) {
      questions[seamQuestionId(i, q.key)] = {
        type: "noul",
        instructions: { cell_a: cellA, cell_b: cellB, question: q.question },
        criteria: NOUL_CRITERIA[q.key],
      }
    }
    questions[seamQuestionId(i, BOUNDARY_LEVEL_QUESTION.key)] = {
      type: "score",
      instructions: {
        cell_a: cellA,
        cell_b: cellB,
        question: BOUNDARY_LEVEL_QUESTION.question,
      },
      criteria: [...BOUNDARY_LEVEL_CRITERIA],
    }
  }

  return { model, state, questions }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function noulValue(answer: unknown): number | undefined {
  if (!answer || typeof answer !== "object") return undefined
  const v = (answer as { noul?: unknown }).noul
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function scoreLevel(answer: unknown): SeamAnswers["boundary_level"] {
  if (!answer || typeof answer !== "object") return undefined
  const a = answer as { score?: unknown; probabilities?: unknown }
  if (typeof a.score !== "number" || !Number.isFinite(a.score)) return undefined

  let distribution: number[] | undefined
  if (a.probabilities && typeof a.probabilities === "object") {
    const probs = a.probabilities as Record<string, unknown>
    distribution = BOUNDARY_LEVEL_CRITERIA.map((_, level) => {
      const p = probs[String(level)]
      return typeof p === "number" && Number.isFinite(p) ? p : 0
    })
  }
  return { level: a.score, ...(distribution ? { distribution } : {}) }
}

/**
 * Demux one response into per-seam answers, in window order.
 *
 * Every field is optional and every seam may come back null. A seam whose
 * answers are missing or malformed is NOT an error: combineSeam falls back to
 * punctuation for exactly that seam and drafting proceeds. A partial response
 * degrading one seam is far better than a throw that un-groups a whole file.
 */
export function parseSeamAnswers(
  body: unknown,
  seamCount: number,
): (SeamAnswers | null)[] {
  const answers =
    body && typeof body === "object"
      ? ((body as { answers?: unknown }).answers as Record<string, unknown> | undefined)
      : undefined

  const out: (SeamAnswers | null)[] = []
  for (let i = 0; i < seamCount; i++) {
    if (!answers || typeof answers !== "object") {
      out.push(null)
      continue
    }
    const seam: SeamAnswers = {}
    let any = false
    for (const q of SEAM_QUESTIONS) {
      const v = noulValue(answers[seamQuestionId(i, q.key)])
      if (v !== undefined) {
        seam[q.key] = v
        any = true
      }
    }
    const level = scoreLevel(answers[seamQuestionId(i, BOUNDARY_LEVEL_QUESTION.key)])
    if (level) {
      seam.boundary_level = level
      any = true
    }
    out.push(any ? seam : null)
  }
  return out
}
