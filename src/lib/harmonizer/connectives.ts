// Textual metafunction — conjunction: does the target's connective express the
// source's relation? (AQU-1676)
//
// γάρ gives a reason, οὖν an inference, δέ a development or contrast, ἀλλά a
// correction. A draft that renders γάρ as "so" reverses the logic between two
// verses; drafting cell by cell makes it easy, because the relation points at
// a verse the model was not shown.
//
// Leaving a relation UNMARKED is often right — English drops many a "for",
// and many languages signal relations by word order, particles or nothing — so
// a missing connective is never a finding. Only a CONTRADICTION is: the target
// marks a relation that reverses the source's (see CONTRADICTS).
//
// Two `choice` questions per boundary, one per side, from the same option set,
// so the comparison is code, not a judgement Jev makes:
//   source  how does cell b relate to cell a?
//   target  which relation does cell b's opening connective (if any) express?
// Finding = both confident and the pair is a contradiction (CONTRADICTS).
// Flag only: choosing the connective is wording.

import { wordSpans } from "./segment"
import type { HarmonizerCell, HarmonizerFinding, HarmonizerQuestion, HarmonyCheck } from "./types"

export const RELATIONS = {
  addition: "adds the next event or point in sequence (and, then)",
  contrast: "contrasts with or corrects the previous cell (but, however, rather)",
  reason: "gives the reason or explanation for the previous cell (for, because)",
  inference: "draws a conclusion or result from the previous cell (therefore, so)",
  time: "sets the time or circumstance for what follows (when, after this)",
  none: "starts fresh with no connection to the previous cell, or no connective",
} as const
export type Relation = keyof typeof RELATIONS

/**
 * Source~target pairs that REVERSE the logic. Everything else is left alone.
 *
 * Measured, not guessed (harmonizer eval, BSB + Macula, 2026-10-05): every
 * clean-text alarm had a weak source relation — καί or narrative δέ read as
 * "addition" (addition~time 82, ~inference 46, ~contrast 23 across all
 * boundaries) — because English rightly renders those as "When", "So",
 * "But". Every expected hit was a reversal: reason↔inference (γάρ↔οὖν) or
 * contrast→inference. Restricting to these kept all 18 hits and cut clean
 * alarms from 198 to 2.
 */
export const CONTRADICTS: ReadonlySet<string> = new Set([
  "reason~inference",
  "inference~reason",
  "contrast~inference",
])

export const MAX_CONNECTIVE_BOUNDARIES = 8
/** 0.6 from the eval: 45% of swapped connectives found, 1 connective alarm in
 *  200 clean passages; 0.7 halved recall for no gain. */
export const CONNECTIVE_MIN_PROBABILITY = 0.6
const MAX_WORD_OPTIONS = 6

export interface ConnectiveBoundary {
  b: number
  words: { start: number; end: number; text: string }[]
}

export interface ConnectivePlan {
  boundaries: ConnectiveBoundary[]
}

const label = (i: number) => `cell ${i}`

function choiceValue(answer: unknown): { choice: string; probability: number } | undefined {
  const a = answer as { choice?: unknown; probabilities?: Record<string, unknown> } | null
  if (!a || typeof a.choice !== "string") return undefined
  const p = a.probabilities?.[a.choice]
  return { choice: a.choice, probability: typeof p === "number" && Number.isFinite(p) ? p : 0 }
}

const isRelation = (s: string): s is Relation => s in RELATIONS

export function connectiveBoundaries(cells: readonly HarmonizerCell[], max = MAX_CONNECTIVE_BOUNDARIES): ConnectiveBoundary[] {
  const centre = (cells.length - 1) / 2
  const out: ConnectiveBoundary[] = []
  for (let b = 1; b < cells.length; b++) {
    const a = cells[b - 1]
    const cell = cells[b]
    if (!a.target.trim() || !cell.target.trim() || !cell.source.trim()) continue
    if (cell.validated) continue
    const words = wordSpans(cell.target, MAX_WORD_OPTIONS)
    if (words.length === 0) continue
    out.push({ b, words })
  }
  return out.sort((x, y) => Math.abs(x.b - centre) - Math.abs(y.b - centre) || x.b - y.b).slice(0, max)
}

export const connectiveCheck: HarmonyCheck<ConnectivePlan> = {
  id: "textual.connective",
  metafunction: "textual",

  plan(cells) {
    const boundaries = connectiveBoundaries(cells)
    return boundaries.length > 0 ? { boundaries } : null
  },

  questions(plan, prefix) {
    const out: Record<string, HarmonizerQuestion> = {}
    const criteria = (side: string) =>
      Object.fromEntries(Object.entries(RELATIONS).map(([k, v]) => [k, `In the ${side}, cell_b ${v}.`]))
    plan.boundaries.forEach(({ b }, i) => {
      const pair = { cell_a: label(b - 1), cell_b: label(b) }
      out[`${prefix}c${i}_source`] = {
        type: "choice",
        instructions: {
          ...pair,
          question: "Read the SOURCE. How does cell_b relate to cell_a? Judge by its connective word or particle if it has one (e.g. Greek γάρ, οὖν, δέ, ἀλλά, καί), otherwise by meaning.",
        },
        criteria: criteria("SOURCE"),
      }
      out[`${prefix}c${i}_target`] = {
        type: "choice",
        instructions: {
          ...pair,
          question: "Read the TARGET. Which relation does the connective word at the start of cell_b express? If cell_b's target has no connective, answer none.",
        },
        criteria: criteria("TARGET"),
      }
      const words = Object.fromEntries(plan.boundaries[i].words.map((w, j) => [`w${j}`, `"${w.text}" is the connective.`]))
      out[`${prefix}c${i}_word`] = {
        type: "choice",
        instructions: { cell: label(b), question: "In the TARGET of this cell, which word is the connective that links it to the previous cell?" },
        criteria: { ...words, none: "There is no connective word." },
      }
    })
    return out
  },

  findings(plan, cells, answers, prefix, opts) {
    const min = opts?.minProbability ?? CONNECTIVE_MIN_PROBABILITY
    const out: HarmonizerFinding[] = []
    plan.boundaries.forEach(({ b, words }, i) => {
      const source = choiceValue(answers[`${prefix}c${i}_source`])
      const target = choiceValue(answers[`${prefix}c${i}_target`])
      if (!source || !target || !isRelation(source.choice) || !isRelation(target.choice)) return
      if (source.probability < min || target.probability < min) return
      if (!CONTRADICTS.has(`${source.choice}~${target.choice}`)) return
      const picked = choiceValue(answers[`${prefix}c${i}_word`])
      const m = picked && picked.probability >= 0.5 ? /^w(\d+)$/.exec(picked.choice) : null
      const word = (m && words[Number(m[1])]) || words[0]
      out.push({
        checkId: connectiveCheck.id,
        metafunction: "textual",
        cellId: cells[b].id,
        start: word.start,
        end: word.end,
        old: word.text,
        new: word.text,
        flagOnly: true,
        reasonKey: `harmonizer.connective.${source.choice}`,
        reasonValues: { previous: cells[b - 1].ref ?? label(b - 1) },
        confidence: Math.min(source.probability, target.probability),
      })
    })
    return out
  },
}
