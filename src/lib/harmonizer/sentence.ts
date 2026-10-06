// Textual metafunction — sentence continuity at a seam (AQU-1659).
//
// Cells are verses, and verses do not respect sentences: "And when he had
// finished speaking, he said | to Simon, Put out into the deep." Drafted one
// cell at a time, a translation can end a sentence the source carries on, or
// run on where the source stops. Splitting a long source sentence into
// several target sentences is often GOOD translation, so "the source runs on
// but the target stops" is not a finding by itself. What is wrong is a target
// that does not hold together as a target:
//
//   broken case   a ends with sentence-final punctuation but b starts in
//                 lowercase (a cased script). The target contradicts itself.
//                 Deterministic: no Jev question needed.
//   broken off    a ends with sentence-final punctuation, the SOURCE sentence
//                 runs on into b, and a's TARGET is not a complete sentence
//                 on its own — the period cut a sentence in half.
//   run on        a ends bare (a letter or digit, no punctuation at all), the
//                 SOURCE sentence ends at a, and b's TARGET does not continue
//                 a's — a sentence missing its end. The fix is deterministic:
//                 the project's own sentence terminator, learned from its
//                 validated cells (". " or "।" or "။" or "。").
//
// The source question is the seam classifier's `continues_sentence`, verbatim
// (src/lib/completion/seams.ts), so this check and drafting-unit grouping are
// asking — and can be evaluated on — the same thing. Cached seams cannot be
// reused: they store the combined join decision, not this answer, and seam
// classification is off by default.

import { SEAM_QUESTIONS } from "../completion/seams"
import { closingSpan } from "./quotes"
import type { HarmonizerCell, HarmonizerFinding, HarmonizerQuestion, HarmonyCheck } from "./types"

export const MAX_SENTENCE_BOUNDARIES = 8
export const SENTENCE_MIN_PROBABILITY = 0.7

/** Sentence-final marks in the TARGET. Stricter than the seam heuristic's
 *  source test: a colon or semicolon followed by lowercase is fine prose. */
const TERMINATORS = ".!?։۔؟।॥。！？።"
const ENDS_TERMINAL = new RegExp(`[${TERMINATORS}]$`, "u")
const TRAILING_CLOSERS = /[\s"'”’»›）)\]}」』]+$/u
const ELLIPSIS = /(\.\.\.|…)$/u
const BARE_END = /[\p{L}\p{N}]$/u
const FIRST_LETTER = /\p{L}/u

const CONTINUES_SENTENCE = SEAM_QUESTIONS.find((q) => q.key === "continues_sentence")!.question

/** a's target ends a sentence: a terminator, possibly followed by closing
 *  quotes or brackets. An ellipsis is a trailing-off, not an end. */
export function endsSentence(target: string): boolean {
  const core = target.trimEnd().replace(TRAILING_CLOSERS, "")
  return core.length > 0 && ENDS_TERMINAL.test(core) && !ELLIPSIS.test(core)
}

/** a's target ends with no punctuation at all. */
export function endsBare(target: string): boolean {
  return BARE_END.test(target.trimEnd())
}

/** b's target starts with a lowercase letter in a script that has case. */
export function startsLowercase(target: string): boolean {
  const m = FIRST_LETTER.exec(target)
  if (!m) return false
  const ch = m[0]
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase()
}

/** The terminator this project ends its sentences with: the most common one
 *  ending a validated cell, else any cell in the passage, else none. */
export function learnTerminator(cells: readonly HarmonizerCell[]): string | null {
  const pick = (texts: readonly string[]): string | null => {
    const counts = new Map<string, number>()
    for (const t of texts) {
      const core = t.trimEnd().replace(TRAILING_CLOSERS, "")
      const last = core.slice(-1)
      if (last && TERMINATORS.includes(last) && !ELLIPSIS.test(core)) counts.set(last, (counts.get(last) ?? 0) + 1)
    }
    let best: string | null = null
    let bestCount = 0
    for (const [ch, n] of counts) if (n > bestCount) [best, bestCount] = [ch, n]
    return best
  }
  return pick(cells.filter((c) => c.validated).map((c) => c.target)) ?? pick(cells.map((c) => c.target))
}

export type SentenceCase = "brokenCase" | "brokenOff" | "runOn"

export interface SentenceBoundary {
  /** Index of cell b; cell a is b - 1. */
  b: number
  kind: SentenceCase
}

export interface SentencePlan {
  boundaries: SentenceBoundary[]
  terminator: string | null
}

/**
 * Classify each boundary from the TARGET alone; only the ambiguous kinds go to
 * Jev. Boundaries where both cells are validated are skipped — people already
 * read that join. Nearest the centre (the active cell) first, capped.
 */
export function sentenceBoundaries(cells: readonly HarmonizerCell[], max = MAX_SENTENCE_BOUNDARIES): SentenceBoundary[] {
  const centre = (cells.length - 1) / 2
  const out: SentenceBoundary[] = []
  for (let b = 1; b < cells.length; b++) {
    const a = cells[b - 1]
    const next = cells[b]
    if (!a.target.trim() || !next.target.trim()) continue
    if (a.validated && next.validated) continue
    if (endsSentence(a.target)) {
      out.push({ b, kind: startsLowercase(next.target) ? "brokenCase" : "brokenOff" })
    } else if (endsBare(a.target)) {
      out.push({ b, kind: "runOn" })
    }
  }
  return out.sort((x, y) => Math.abs(x.b - centre) - Math.abs(y.b - centre) || x.b - y.b).slice(0, max)
}

const label = (i: number) => `cell ${i}`

function noulValue(answer: unknown): number | undefined {
  const v = (answer as { noul?: unknown } | null)?.noul
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

export const sentenceCheck: HarmonyCheck<SentencePlan> = {
  id: "textual.sentence",
  metafunction: "textual",

  plan(cells) {
    const boundaries = sentenceBoundaries(cells)
    return boundaries.length > 0 ? { boundaries, terminator: learnTerminator(cells) } : null
  },

  questions(plan, prefix) {
    const out: Record<string, HarmonizerQuestion> = {}
    plan.boundaries.forEach(({ b, kind }, i) => {
      if (kind === "brokenCase") return // the target contradicts itself; nothing to ask
      const pair = { cell_a: label(b - 1), cell_b: label(b) }
      out[`${prefix}t${i}_continues`] = {
        type: "noul",
        instructions: { ...pair, question: `Read the SOURCE. ${CONTINUES_SENTENCE}` },
        criteria: {
          true: "In the SOURCE, cell_b finishes a sentence that cell_a leaves incomplete.",
          false: "In the SOURCE, cell_a's sentence is complete at the end of cell_a.",
        },
      }
      if (kind === "brokenOff") {
        out[`${prefix}t${i}_complete`] = {
          type: "noul",
          instructions: {
            cell: label(b - 1),
            question: "Read only the TARGET of this cell. Is its last sentence grammatically complete on its own?",
          },
          criteria: {
            true: "The last sentence of the target is complete.",
            false: "The last sentence is cut off and needs the next cell to be complete.",
          },
        }
      } else {
        out[`${prefix}t${i}_targetContinues`] = {
          type: "noul",
          instructions: {
            ...pair,
            question: "Read the TARGET of cell_a and then cell_b. Does cell_b's target continue a sentence that cell_a's target leaves open?",
          },
          criteria: {
            true: "cell_b's target carries on cell_a's sentence.",
            false: "cell_b's target starts a new sentence.",
          },
        }
      }
    })
    return out
  },

  findings(plan, cells, answers, prefix) {
    const out: HarmonizerFinding[] = []
    plan.boundaries.forEach(({ b, kind }, i) => {
      const a = cells[b - 1]
      const span = closingSpan(a.target)
      if (!span) return
      const old = a.target.slice(span.start, span.end)
      const base = {
        checkId: sentenceCheck.id,
        metafunction: "textual" as const,
        cellId: a.id,
        start: span.start,
        end: span.end,
        old,
        reasonValues: { next: cells[b].ref ?? label(b) },
      }
      if (kind === "brokenCase") {
        out.push({ ...base, new: old, flagOnly: true, reasonKey: "harmonizer.sentence.brokenCase", confidence: 1 })
        return
      }
      const continues = noulValue(answers[`${prefix}t${i}_continues`])
      if (continues === undefined) return
      if (kind === "brokenOff") {
        const complete = noulValue(answers[`${prefix}t${i}_complete`])
        if (complete === undefined) return
        if (continues < SENTENCE_MIN_PROBABILITY || 1 - complete < SENTENCE_MIN_PROBABILITY) return
        out.push({
          ...base, new: old, flagOnly: true, reasonKey: "harmonizer.sentence.brokenOff",
          confidence: Math.min(continues, 1 - complete),
        })
        return
      }
      // runOn
      if (!plan.terminator) return
      const targetContinues = noulValue(answers[`${prefix}t${i}_targetContinues`])
      if (targetContinues === undefined) return
      if (1 - continues < SENTENCE_MIN_PROBABILITY || 1 - targetContinues < SENTENCE_MIN_PROBABILITY) return
      out.push({
        ...base, new: old + plan.terminator, reasonKey: "harmonizer.sentence.runOn",
        confidence: Math.min(1 - continues, 1 - targetContinues),
      })
    })
    return out
  },
}
