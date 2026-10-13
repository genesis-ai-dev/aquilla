// judgeExpectations — Bible data questions that code cannot settle, asked of
// Jev (AQU-1690; design doc §9.3). Runs between lint and classifyRisk.
//
// Code first. Each question is asked only when the pack says it applies AND
// code could not decide it from the Language profile:
//
//   speaker (V13)    "In this translation, are the quoted words spoken by {speaker}?"
//                    — a speech opens in the cell and the profile lists speech
//                      verbs, but the draft does not show the speaker's name
//                      next to one of them.
//   question (M1)    "Is this sentence still a question?"
//                    — the source asks a question, the profile has no question
//                      markers (so the M1 gate is dormant), and the draft has
//                      no question mark.
//   negation (M3)    "Is this statement negative?"
//                    — the Greek has negators and the draft has none of the
//                      profile's negators.
//   you_number (P8)  "Is 'you' here addressed to one person?"
//                    — the Greek has second-person forms of one number, the
//                      profile says the language distinguishes number, but it
//                      lists no forms to check.
//
// ONE batched decide() per span, with keys `c{i}_{check}`. An answer whose
// certainty |p − 0.5|·2 is below 0.4 abstains, as does every answer when Jev
// is off, capped or down. Answers are cached per run by (cell content hash,
// check, pack version).
//
// SHADOW MODE BY DEFAULT. Every question starts in shadow: its answers are
// recorded in the run's traces with their certainty, and never trigger a
// redraft or a finding. A question moves to "active" in BIBLE_QA_MODES below —
// a reviewed code change, so maintainers only — once its shadow eval shows it
// is precise enough (design doc §10).

import { QUESTION_MARK, UNSPACED_SCRIPT, WORD_PART, escapeRegExp, isBibleCheckDormant } from "../../../../db/shared/bible-checks/evaluate"
import type { CellExpectation } from "../../../../db/shared/bible-checks/types"
import type { CellFacts, FactEntity } from "../../../../db/shared/bible-facts/types"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import type { DecideInput, DecideResult, JevAnswer, JevQuestion } from "../jev/decide"
import { promptFingerprint } from "./draft"

export const BIBLE_QA_CHECKS = ["speaker", "question", "negation", "you_number"] as const
export type BibleQaCheck = (typeof BIBLE_QA_CHECKS)[number]

/** The finding code an ACTIVE question's "no" is recorded under. */
export const BIBLE_QA_CODES: Readonly<Record<BibleQaCheck, `bkp:${string}`>> = {
  speaker: "bkp:V13",
  question: "bkp:M1",
  negation: "bkp:M3",
  you_number: "bkp:P8",
}

export type BibleQaMode = "shadow" | "active"

/**
 * Maintainer switch, per question. Shadow: answers are traced, never acted on.
 * Active: a confident "no" becomes a `bkp:` finding and a repair constraint.
 * Change one only after its shadow eval (design doc §10) — this is a code
 * change on purpose, so it is reviewed and it ships with the eval numbers.
 */
export const BIBLE_QA_MODES: Readonly<Record<BibleQaCheck, BibleQaMode>> = {
  speaker: "shadow",
  question: "shadow",
  negation: "shadow",
  you_number: "shadow",
}

/** Below this certainty (|p − 0.5|·2) an answer abstains, as passage tags and seams do. */
export const BIBLE_QA_ABSTAIN_BELOW = 0.4
const TEXT_MAX = 400

export interface JudgeCell {
  cellId: string
  ref: string | null
  source: string
  text: string
  facts?: CellFacts
  expectation?: CellExpectation
  /** The cell's facts line, given to Jev as context. */
  factsLine?: string
}

export interface Judgment {
  cellId: string
  check: BibleQaCheck
  /** pass: the draft keeps the fact; fail: it does not; abstain: unsure or unanswered. */
  outcome: "pass" | "fail" | "abstain"
  decidedBy: "code" | "jev" | "cache" | "fallback"
  mode: BibleQaMode
  /** p(yes), when Jev answered (now or from the cache). */
  p?: number
  certainty?: number
}

export interface JudgeResult {
  judgments: Judgment[]
  /** decide() calls this span made: 0 or 1. */
  jevCalls: number
}

/** One call's record for the run's traces and the cost meter. */
export interface BibleQaTrace {
  spanId: string
  request: { state: Record<string, unknown>; questions: Record<string, JevQuestion> }
  result: DecideResult
  judgments: Judgment[]
  latencyMs: number
}

export type BibleQaDecide = (input: Pick<DecideInput, "state" | "questions" | "fallback">) => Promise<DecideResult>

export interface JudgeDeps {
  profile: LanguageProfile
  packVersion: string
  decide: BibleQaDecide
  /** p(yes) per (cell content hash, check, pack version), kept for the run. */
  cache: Map<string, number>
  record?: (trace: BibleQaTrace) => void
  /** Test seam; production reads BIBLE_QA_MODES. */
  modes?: Readonly<Record<BibleQaCheck, BibleQaMode>>
}

// ── Code ────────────────────────────────────────────────────────────────────

/** `term` appears in `text` as a whole word, ignoring case; anywhere, in a script written without spaces. */
export function containsTerm(text: string, term: string): boolean {
  const value = term.trim()
  if (!value) return false
  const word = escapeRegExp(value)
  const pattern = UNSPACED_SCRIPT.test(value) ? word : `(?<!${WORD_PART})${word}(?!${WORD_PART})`
  return new RegExp(pattern, "iu").test(text)
}

function nameOf(entity: FactEntity): string {
  return entity.rendering ?? entity.label
}

interface Pending {
  cell: JudgeCell
  index: number
  check: BibleQaCheck
  question: string
  /** p(yes) means the draft keeps the fact; for you_number, yes means singular. */
  passWhenYes: boolean
}

type Candidate = { decided: "pass" } | { ask: Omit<Pending, "cell" | "index"> } | null

function speakerCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  const verbs = profile.speechVerbs ?? []
  if (verbs.length === 0) return null
  const speech = cell.facts?.speeches.find((s) => s.opens && !s.selfProjected && s.speaker)
  if (!speech?.speaker) return null
  const name = nameOf(speech.speaker)
  if (containsTerm(cell.text, name) && verbs.some((verb) => containsTerm(cell.text, verb))) return { decided: "pass" }
  return {
    ask: {
      check: "speaker",
      question: `In this translation, are the quoted words spoken by ${name}?`,
      passWhenYes: true,
    },
  }
}

function questionCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  if (!cell.expectation?.question.expected) return null
  // With question markers in the profile the M1 gate decides in code.
  if (!isBibleCheckDormant("bkp:M1", profile)) return null
  if (QUESTION_MARK.test(cell.text)) return { decided: "pass" }
  return { ask: { check: "question", question: "Is this sentence still a question?", passWhenYes: true } }
}

function negationCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  if (!cell.facts || cell.facts.negators === 0) return null
  if ((profile.negators ?? []).some((negator) => containsTerm(cell.text, negator))) return { decided: "pass" }
  return { ask: { check: "negation", question: "Is this statement negative?", passWhenYes: true } }
}

function youNumberCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  const number = cell.facts?.secondPerson
  if (number !== "singular" && number !== "plural") return null
  const second = profile.pronouns?.secondPerson
  if (!second?.numberDistinction) return null
  // With forms listed, this is a code check for a later slice, not a question.
  if ((second.singular?.length ?? 0) > 0 || (second.plural?.length ?? 0) > 0) return null
  return {
    ask: { check: "you_number", question: "Is 'you' here addressed to one person?", passWhenYes: number === "singular" },
  }
}

const CANDIDATES: Readonly<Record<BibleQaCheck, (cell: JudgeCell, profile: LanguageProfile) => Candidate>> = {
  speaker: speakerCandidate,
  question: questionCandidate,
  negation: negationCandidate,
  you_number: youNumberCandidate,
}

// ── Jev ─────────────────────────────────────────────────────────────────────

function clip(text: string): string {
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text
}

function cacheKey(cell: JudgeCell, check: BibleQaCheck, packVersion: string): string {
  return `${promptFingerprint(`${cell.source}\u0000${cell.text}`)}|${check}|${packVersion}`
}

function outcomeOf(p: number, passWhenYes: boolean): Pick<Judgment, "outcome" | "certainty"> {
  const certainty = Math.abs(p - 0.5) * 2
  if (certainty < BIBLE_QA_ABSTAIN_BELOW) return { outcome: "abstain", certainty }
  const yes = p >= 0.5
  return { outcome: yes === passWhenYes ? "pass" : "fail", certainty }
}

/**
 * Judge a drafted span. Never throws: a Jev failure is an abstention, and
 * code-decided cells make no call at all.
 */
export async function judgeExpectations(
  cells: readonly JudgeCell[],
  deps: JudgeDeps,
  spanId: string,
): Promise<JudgeResult> {
  const modes = deps.modes ?? BIBLE_QA_MODES
  const judgments: Judgment[] = []
  const pending: Pending[] = []
  cells.forEach((cell, index) => {
    for (const check of BIBLE_QA_CHECKS) {
      const candidate = CANDIDATES[check](cell, deps.profile)
      if (!candidate) continue
      if ("decided" in candidate) {
        judgments.push({ cellId: cell.cellId, check, outcome: "pass", decidedBy: "code", mode: modes[check] })
        continue
      }
      const cached = deps.cache.get(cacheKey(cell, check, deps.packVersion))
      if (cached !== undefined) {
        judgments.push({
          cellId: cell.cellId,
          check,
          ...outcomeOf(cached, candidate.ask.passWhenYes),
          decidedBy: "cache",
          mode: modes[check],
          p: cached,
        })
        continue
      }
      pending.push({ cell, index, ...candidate.ask })
    }
  })
  if (pending.length === 0) return { judgments, jevCalls: 0 }

  const keyOf = (q: Pending) => `c${q.index}_${q.check}`
  const questions: Record<string, JevQuestion> = {}
  for (const q of pending) {
    questions[keyOf(q)] = {
      type: "noul",
      instructions: { cell: `cell ${q.index}`, question: q.question },
      criteria: { true: "Yes: the translation says so.", false: "No: the translation does not say so." },
    }
  }
  const asked = [...new Set(pending.map((q) => q.index))]
  const state = {
    cells: asked.map((index) => ({
      index,
      ref: cells[index].ref,
      source: clip(cells[index].source),
      translation: clip(cells[index].text),
      ...(cells[index].factsLine ? { facts: clip(cells[index].factsLine ?? "") } : {}),
    })),
  }
  // An unanswered question is p = 0.5: certainty 0, so it abstains.
  const fallback = (): Record<string, JevAnswer> =>
    Object.fromEntries(pending.map((q) => [keyOf(q), { kind: "noul", p: 0.5 } as JevAnswer]))

  const started = Date.now()
  let result: DecideResult
  try {
    result = await deps.decide({ state, questions, fallback })
  } catch (err) {
    console.warn("[bible-qa] decide failed; every question abstains:", err instanceof Error ? err.message : err)
    result = { answers: fallback(), decidedBy: "heuristic", reason: "upstream", model: null, usage: null }
  }
  const fromJev: Judgment[] = pending.map((q) => {
    const answer = result.answers[keyOf(q)]
    const p = answer?.kind === "noul" ? answer.p : 0.5
    const answered = result.decidedBy !== "heuristic" && p !== 0.5
    if (answered) deps.cache.set(cacheKey(q.cell, q.check, deps.packVersion), p)
    return {
      cellId: q.cell.cellId,
      check: q.check,
      ...outcomeOf(p, q.passWhenYes),
      decidedBy: answered ? "jev" : "fallback",
      mode: modes[q.check],
      ...(answered ? { p } : {}),
    }
  })
  deps.record?.({ spanId, request: { state, questions }, result, judgments: fromJev, latencyMs: Date.now() - started })
  return { judgments: [...judgments, ...fromJev], jevCalls: 1 }
}

/** The judgments that act: an ACTIVE question answered "no" with certainty. Shadow answers never do. */
export function activeFailures(result: JudgeResult): Judgment[] {
  return result.judgments.filter((j) => j.mode === "active" && j.outcome === "fail")
}

/** The templated English constraint for an active failure, from the cell's facts. */
export function judgmentConstraint(judgment: Pick<Judgment, "check">, facts: CellFacts | undefined): string {
  const speech = facts?.speeches.find((s) => s.opens && !s.selfProjected && s.speaker)
  switch (judgment.check) {
    case "speaker":
      return speech?.speaker
        ? `Make clear that ${nameOf(speech.speaker)} speaks these words.`
        : "Make clear who speaks these words."
    case "question":
      return "Keep the question: the source asks one."
    case "negation":
      return "Keep the negation: the source says \"not\"."
    case "you_number": {
      const one = facts?.secondPerson === "singular"
      const addressee = facts?.speeches.find((s) => s.addressee)?.addressee
      const who = addressee ? `${nameOf(addressee)} is ${one ? "one person" : "more than one person"}` : `it is addressed to ${one ? "one person" : "several people"}`
      return `Use ${one ? "singular" : "plural"} "you": ${who}.`
    }
  }
}
