/**
 * react-route.ts — the react loop's two Jev decisions: WHETHER to react to a
 * human edit, and WHAT to do (docs/superpowers/specs/
 * 2026-09-30-jev-react-decisions-design.md §2).
 *
 * Jev answers; this module decides. The thresholds, the scope filter, and the
 * fixed-rule fallback live here as plain code so every routing outcome is a
 * table test, and a Jev outage reproduces today's behaviour (minus reactions to
 * formatting-only edits).
 */

import type { AgentScope } from "./agent-mode"
import type { JevAnswer, JevQuestion } from "./jev/decide"

export type ReactAction = "skip" | "ask" | "redraft" | "check" | "learn"

/** One edited cell as Jev sees it. Texts are pre-truncated by the caller. */
export interface EditSample {
  ref: string | null
  source: string
  before: string
  after: string
}

export const SUBSTANTIVE_MIN = 0.5
export const UNCLEAR_MIN = 0.6
export const ACTION_MIN = 0.5
/** Cells sent per signal, and characters per text. */
export const REACT_SAMPLE_CELLS = 5
export const REACT_SAMPLE_CHARS = 400

export const REACT_QUESTIONS: Record<string, JevQuestion> = {
  substantive: {
    type: "noul",
    instructions: {
      question:
        "Across these edits (before → after, with the source text), did the expert change meaning, terminology, a name, or style?",
    },
    criteria: {
      true: "At least one edit changes what the translation says or how a term, name, or style is rendered.",
      false: "The edits only fix typos, punctuation, spacing, or capitalisation.",
    },
  },
  unclear_intent: {
    type: "noul",
    instructions: { question: "Is the expert's intent unclear enough that asking them first is better than acting?" },
    criteria: {
      true: "The change could reasonably mean different things for the rest of the text.",
      false: "What the expert wanted is clear from the edits.",
    },
  },
  want_redraft: {
    type: "noul",
    instructions: { question: "Should nearby passages be redrafted in light of these edits?" },
    criteria: {
      true: "The edits change how neighbouring text should read (a new rendering, a corrected sense, a shifted style).",
      false: "Neighbouring drafts do not depend on this change.",
    },
  },
  want_check: {
    type: "noul",
    instructions: { question: "Should nearby drafts be re-checked against these edits instead of redrafted?" },
    criteria: {
      true: "Neighbouring drafts might now conflict with the edits, but may well be fine.",
      false: "There is nothing nearby that these edits could conflict with.",
    },
  },
  want_learn: {
    type: "noul",
    instructions: {
      question: "Do the edits express a reusable rule (a term, a name spelling, a style choice) the team should remember?",
    },
    criteria: {
      true: "The same choice should apply wherever the term, name, or construction appears again.",
      false: "The edits are specific to these cells.",
    },
  },
}

/** Compare texts the way a reader would: ignore spacing, punctuation, case. */
export function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "")
}

/**
 * Fixed-rule answers with the same keys as REACT_QUESTIONS — what the loop
 * does when Jev is off, capped, slow, or down. A validation is expert input in
 * its own right even though no text changed.
 */
export function fallbackReactAnswers(
  samples: EditSample[],
  options: { validationOnly?: boolean } = {},
): Record<string, JevAnswer> {
  // Only readable, unchanged text is proof of a formatting-only edit. Missing
  // or empty samples (an unreadable log, a payload without text) are unknown,
  // and unknown behaves exactly as the loop did before Jev: react.
  const readable = samples.filter((s) => s.after.trim() !== "")
  const formattingOnly =
    readable.length > 0 &&
    readable.length === samples.length &&
    readable.every((s) => normalizeForCompare(s.before) === normalizeForCompare(s.after))
  const substantive = options.validationOnly === true || !formattingOnly
  return {
    substantive: { kind: "noul", p: substantive ? 1 : 0 },
    unclear_intent: { kind: "noul", p: 0 },
    want_redraft: { kind: "noul", p: 1 },
    want_check: { kind: "noul", p: 0 },
    want_learn: { kind: "noul", p: 0 },
  }
}

function prob(answers: Record<string, JevAnswer>, key: string): number {
  const a = answers[key]
  return a?.kind === "noul" ? a.p : 0
}

const ALLOWED: Record<AgentScope, ReadonlySet<ReactAction>> = {
  full: new Set(["redraft", "check", "learn"]),
  qa: new Set(["check", "learn"]),
  draft: new Set(["redraft", "learn"]),
}
const SCOPE_DEFAULT: Record<AgentScope, ReactAction> = { full: "check", qa: "check", draft: "redraft" }

export interface ReactRoute {
  action: ReactAction
  /** Probabilities for the step inspector; never shown as prose. */
  scores: Record<string, number>
}

export function routeReaction(answers: Record<string, JevAnswer>, scope: AgentScope): ReactRoute {
  const scores = Object.fromEntries(Object.keys(REACT_QUESTIONS).map((k) => [k, prob(answers, k)]))
  if (scores.substantive < SUBSTANTIVE_MIN) return { action: "skip", scores }
  if (scores.unclear_intent >= UNCLEAR_MIN) return { action: "ask", scores }
  const ranked = (["redraft", "check", "learn"] as const)
    .map((action) => ({ action, p: scores[`want_${action}`] }))
    .filter((c) => c.p >= ACTION_MIN && ALLOWED[scope].has(c.action))
    .sort((a, b) => b.p - a.p)
  return { action: ranked[0]?.action ?? SCOPE_DEFAULT[scope], scores }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The expert question for "ask": templated, never model-written. */
export function askQuestionText(samples: EditSample[], count: number): string {
  const first = samples[0]
  const where = first?.ref ? `${first.ref}` : "a passage"
  const plural = count === 1 ? "an edit" : `${count} edits`
  const change = first ? ` from “${clip(first.before, 160)}” to “${clip(first.after, 160)}”` : ""
  return `You made ${plural} at ${where}${change}. Should the team apply this change elsewhere, or was it specific to this spot?`
}

// ── Wording ─────────────────────────────────────────────────────────────────

/** Canonical refs quoted in the auto-steering direction. */
const REACT_MAX_REFS_IN_DIRECTION = 3

export function refsLabel(refs: string[]): string {
  if (refs.length === 0) return "the edited passages"
  const shown = refs.slice(0, REACT_MAX_REFS_IN_DIRECTION)
  const more = refs.length - shown.length
  return more > 0 ? `${shown.join(", ")} (+${more} more)` : shown.join(", ")
}

/** The direction a reaction run is seeded with, per routed action. */
export function actionDirection(
  action: Exclude<ReactAction, "skip" | "ask">,
  count: number,
  refs: string[],
): string {
  const plural = count === 1 ? "edit" : "edits"
  const trigger = `React to ${count} human ${plural} near ${refsLabel(refs)}`
  switch (action) {
    case "check":
      return `${trigger}: verify and report on the surrounding drafts; do not redraft unless a check fails.`
    case "learn":
      return `${trigger}: the change looks like a reusable rule (a term, a name spelling, or a style choice). ` +
        `Propose it as a project memory or terminology entry for review; do not redraft.`
    case "redraft":
      return `${trigger}: reassess the surrounding passages and update drafts where the human's changes have implications.`
  }
}

export const ACTION_WHY: Record<Exclude<ReactAction, "skip" | "ask">, string> = {
  redraft: "updating the surrounding drafts where the change has implications",
  check: "re-checking the surrounding drafts against the change",
  learn: "proposing the change as a reusable rule for the team to approve",
}
