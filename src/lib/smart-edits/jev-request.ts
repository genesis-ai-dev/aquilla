// Smart edits — tier 1 wire format: Jev picks the wording to emulate.
//
// Jev never writes text. For each uncertain tier-0 suggestion it gets ONE
// `choice` question (TypeSafe docs: primitives/choice) whose options are
// "keep" plus the replacements the edit memory found, and the evidence — the
// cells where the team made each edit, source and before/after — sits in
// `state` once, referenced by id. Everything for a passage goes in one request:
// batched questions cost the same answers for a fraction of the price
// (TypeSafe parallel-questions study), while unrelated state lowers accuracy,
// so state carries the passage and the chosen evidence only.
//
// Alias-free so auth-worker and scripts/ can import it.

import type { ScoredSuggestion } from "./suggest"

export interface JevChoiceQuestion {
  type: "choice"
  instructions: Record<string, unknown>
  criteria: Record<string, string>
}

export interface SmartEditJevRequest {
  model: string
  state: Record<string, unknown>
  questions: Record<string, JevChoiceQuestion>
}

export interface PassageCell {
  id: string
  source: string
  target: string
}

/** Most suggestions verified per request; the rest stay unverified (dropped). */
export const MAX_VERIFY_PER_REQUEST = 24
const MAX_EVIDENCE_PER_SUGGESTION = 2

export const KEEP = "keep"

export function questionId(i: number): string {
  return `q${i}`
}

export function optionId(j: number): string {
  return `r${j}`
}

export function buildVerifyRequest(
  model: string,
  cells: readonly PassageCell[],
  toVerify: readonly ScoredSuggestion[],
): SmartEditJevRequest {
  const cellIndex = new Map(cells.map((c, i) => [c.id, i]))
  const evidence: Record<string, { source: string; before: string; after: string }> = {}
  const questions: Record<string, JevChoiceQuestion> = {}
  toVerify.slice(0, MAX_VERIFY_PER_REQUEST).forEach((s, i) => {
    const evidenceIds: string[] = []
    for (const ex of s.examples.slice(0, MAX_EVIDENCE_PER_SUGGESTION)) {
      const id = `e${Object.keys(evidence).length}`
      evidence[id] = { source: ex.sourceText, before: ex.beforeText, after: ex.afterText }
      evidenceIds.push(id)
    }
    const options = [{ new: s.new }, ...s.alternatives.map((a) => ({ new: a.new }))]
    const criteria: Record<string, string> = {
      [KEEP]: `Keep "${s.old}" as written: the evidence does not apply to this cell's source or context.`,
    }
    options.forEach((o, j) => {
      criteria[optionId(j)] = o.new
        ? `Change "${s.old}" to "${o.new}", the way the team edited it in the evidence.`
        : `Delete "${s.old}", the way the team did in the evidence.`
    })
    questions[questionId(i)] = {
      type: "choice",
      instructions: {
        cell: `cell ${cellIndex.get(s.cellId) ?? 0}`,
        phrase: s.old,
        evidence: evidenceIds,
        question:
          "Translators on this project edited this phrase in other cells (see the evidence: each shows the source, the text before, and the text after their edit). Compare the source and surrounding words of this cell with the evidence. Should this cell's phrase get the same edit?",
      },
      criteria,
    }
  })
  return {
    model,
    state: {
      cells: cells.map((c, index) => ({ index, source: c.source, target: c.target })),
      evidence,
    },
    questions,
  }
}

export interface VerifyAnswer {
  /** KEEP, or the index into [suggestion.new, ...alternatives]. */
  choice: typeof KEEP | number
  probability: number
}

/** Parse answers; a missing or malformed answer is `undefined` (= unverified). */
export function parseVerifyAnswers(body: unknown, count: number): (VerifyAnswer | undefined)[] {
  const answers = (body as { answers?: Record<string, unknown> } | null)?.answers ?? {}
  return Array.from({ length: Math.min(count, MAX_VERIFY_PER_REQUEST) }, (_, i) => {
    const a = answers[questionId(i)] as { choice?: unknown; probabilities?: Record<string, unknown> } | undefined
    if (!a || typeof a.choice !== "string") return undefined
    const p = a.probabilities?.[a.choice]
    const probability = typeof p === "number" && Number.isFinite(p) ? p : 0
    if (a.choice === KEEP) return { choice: KEEP, probability }
    const m = /^r(\d+)$/.exec(a.choice)
    return m ? { choice: Number(m[1]), probability } : undefined
  })
}

/** Jev must pick a replacement with at least this probability to show it. */
export const VERIFY_MIN_PROBABILITY = 0.6
