// Textual metafunction — participant reference at a subject switch (AQU-1658).
//
// The drafting error this targets: Greek (and many source languages) carries
// the subject in the verb, so a verse where the speaker or actor changes is
// easily drafted as "he said" — and the reader, carrying the previous verse's
// participant forward, attaches "he" to the wrong person. Drafting cell by
// cell makes it worse: each cell is translated without knowing who the reader
// thinks is on stage.
//
// What counts as "clear" is language-specific (pronoun, name, noun phrase,
// switch-reference marking, zero), so the check never decides that from word
// lists. It asks Jev three atomic questions per boundary — TypeSafe's own
// finding is that atomic questions combined in code beat one broad question
// by a wide margin — and only the combination produces a finding:
//
//   switch   SOURCE  is the main subject of cell b a different participant
//                    from cell a's?
//   clear    TARGET  reading a then b, would a reader identify b's subject as
//                    the participant the source means?
//   word     TARGET  which of b's first words refers to that subject (or is it
//                    only implied)? — a `choice`, so Jev points at the span
//                    without writing anything.
//
// Finding = confident switch AND confident "not clear". It is a FLAG, not a
// replacement: choosing the right name or noun phrase is wording, which is a
// model's job on request, not a rule's.

import { wordSpans } from "./segment"
import type { HarmonizerCell, HarmonizerFinding, HarmonizerQuestion, HarmonyCheck } from "./types"

/** Boundaries asked per passage; nearest the passage centre (the active cell) first. */
export const MAX_BOUNDARIES = 8
/** First words of cell b offered as the subject's span. */
export const MAX_WORD_OPTIONS = 12
export const REFERENCE_MIN_PROBABILITY = 0.7
export const IMPLIED = "implied"

export interface ReferenceBoundary {
  /** Index of cell b; cell a is b - 1. */
  b: number
  words: { start: number; end: number; text: string }[]
}

export interface ReferencePlan {
  boundaries: ReferenceBoundary[]
}

const label = (i: number) => `cell ${i}`
const wordOption = (j: number) => `w${j}`

function noulValue(answer: unknown): number | undefined {
  const v = (answer as { noul?: unknown } | null)?.noul
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function choiceValue(answer: unknown): { choice: string; probability: number } | undefined {
  const a = answer as { choice?: unknown; probabilities?: Record<string, unknown> } | null
  if (!a || typeof a.choice !== "string") return undefined
  const p = a.probabilities?.[a.choice]
  return { choice: a.choice, probability: typeof p === "number" && Number.isFinite(p) ? p : 0 }
}

/**
 * Boundaries worth asking about: both cells drafted, b not yet validated (a
 * validated cell was read by a person who knew who was speaking), nearest the
 * centre of the passage first, which is where the translator is working.
 */
export function referenceBoundaries(cells: readonly HarmonizerCell[], max = MAX_BOUNDARIES): ReferenceBoundary[] {
  const centre = (cells.length - 1) / 2
  const out: ReferenceBoundary[] = []
  for (let b = 1; b < cells.length; b++) {
    const a = cells[b - 1]
    const cell = cells[b]
    if (!a.target.trim() || !cell.target.trim() || !a.source.trim() || !cell.source.trim()) continue
    if (cell.validated) continue
    const words = wordSpans(cell.target, MAX_WORD_OPTIONS)
    if (words.length === 0) continue
    out.push({ b, words })
  }
  return out.sort((x, y) => Math.abs(x.b - centre) - Math.abs(y.b - centre) || x.b - y.b).slice(0, max)
}

export const referenceCheck: HarmonyCheck<ReferencePlan> = {
  id: "textual.reference",
  metafunction: "textual",

  plan(cells) {
    const boundaries = referenceBoundaries(cells)
    return boundaries.length > 0 ? { boundaries } : null
  },

  questions(plan, prefix) {
    const out: Record<string, HarmonizerQuestion> = {}
    plan.boundaries.forEach(({ b, words }, i) => {
      const pair = { cell_a: label(b - 1), cell_b: label(b) }
      out[`${prefix}r${i}_switch`] = {
        type: "noul",
        instructions: {
          ...pair,
          question:
            "Read the SOURCE of cell_a and cell_b. Is the main subject (the person or group doing or saying the main action) of cell_b a different participant from the main subject of cell_a?",
        },
        criteria: {
          true: "cell_b's main subject is a different person or group from cell_a's.",
          false: "The same participant continues as main subject, or there is no clear subject.",
        },
      }
      out[`${prefix}r${i}_clear`] = {
        type: "noul",
        instructions: {
          ...pair,
          question:
            "Read the TARGET of cell_a and then cell_b, as a reader of the translation would. Would that reader correctly identify who the main subject of cell_b is — the same participant the SOURCE of cell_b means?",
        },
        criteria: {
          true: "A reader of the target would identify the right participant.",
          false: "A reader would likely take it to be someone else, or could not tell.",
        },
      }
      const criteria: Record<string, string> = {}
      words.forEach((w, j) => {
        criteria[wordOption(j)] = `"${w.text}" (word ${j + 1}) refers to cell_b's main subject.`
      })
      criteria[IMPLIED] = "No word names the subject; it is only implied by the verb or context."
      out[`${prefix}r${i}_word`] = {
        type: "choice",
        instructions: {
          cell: label(b),
          question: "In the TARGET of this cell, which word refers to the cell's main subject?",
        },
        criteria,
      }
    })
    return out
  },

  findings(plan, cells, answers, prefix) {
    const out: HarmonizerFinding[] = []
    plan.boundaries.forEach(({ b, words }, i) => {
      const switched = noulValue(answers[`${prefix}r${i}_switch`])
      const clear = noulValue(answers[`${prefix}r${i}_clear`])
      if (switched === undefined || clear === undefined) return
      if (switched < REFERENCE_MIN_PROBABILITY || 1 - clear < REFERENCE_MIN_PROBABILITY) return
      // Point at the subject's word when Jev is sure which it is; otherwise at
      // the first word, where an implied subject's clause begins.
      const picked = choiceValue(answers[`${prefix}r${i}_word`])
      const m = picked && picked.probability >= 0.5 ? /^w(\d+)$/.exec(picked.choice) : null
      const word = (m && words[Number(m[1])]) || words[0]
      const cell = cells[b]
      out.push({
        checkId: referenceCheck.id,
        metafunction: "textual",
        cellId: cell.id,
        start: word.start,
        end: word.end,
        old: word.text,
        new: word.text,
        flagOnly: true,
        reasonKey: picked?.choice === IMPLIED && picked.probability >= 0.5
          ? "harmonizer.reference.impliedSubject"
          : "harmonizer.reference.unclearSubject",
        reasonValues: { previous: cells[b - 1].ref ?? label(b - 1) },
        confidence: Math.min(switched, 1 - clear),
      })
    })
    return out
  },
}
