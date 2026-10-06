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
//   referent (P13), we_inclusive (P9), introduced (P11) — AQU-1701, the
//                    participant questions: see ./judge-participants.ts.
//   tq (C1)          AQU-1701, Translation Questions: asked per question and
//                    batched per chapter, not per cell (./judge-comprehension.ts).
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
import { introducedCandidate, referentCandidate, weInclusiveCandidate } from "./judge-participants"

export const BIBLE_QA_CHECKS = [
  "speaker",
  "question",
  "negation",
  "you_number",
  // AQU-1701
  "referent",
  "we_inclusive",
  "introduced",
  "tq",
] as const
export type BibleQaCheck = (typeof BIBLE_QA_CHECKS)[number]

/** The questions asked of one cell. C1 (`tq`) is asked per Translation Question instead (./judge-comprehension.ts). */
export const BIBLE_QA_CELL_CHECKS = BIBLE_QA_CHECKS.filter(
  (check): check is Exclude<BibleQaCheck, "tq"> => check !== "tq",
)
type BibleQaCellCheck = (typeof BIBLE_QA_CELL_CHECKS)[number]

/** The finding code an ACTIVE question's "no" is recorded under. */
export const BIBLE_QA_CODES: Readonly<Record<BibleQaCheck, `bkp:${string}`>> = {
  speaker: "bkp:V13",
  question: "bkp:M1",
  negation: "bkp:M3",
  you_number: "bkp:P8",
  referent: "bkp:P13",
  we_inclusive: "bkp:P9",
  introduced: "bkp:P11",
  tq: "bkp:C1",
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
  // AQU-1701: new questions start in shadow, like every question before its eval.
  referent: "shadow",
  we_inclusive: "shadow",
  introduced: "shadow",
  tq: "shadow",
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
  /** AQU-1701: on a failure, the repair constraint the question carries (P13, P9), built from the pack facts it asked about. */
  repair?: string
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
  /** Test seam, over BIBLE_QA_MODES; production reads BIBLE_QA_MODES alone. */
  modes?: Readonly<Partial<Record<BibleQaCheck, BibleQaMode>>>
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
  check: BibleQaCellCheck
  question: string
  /** p(yes) means the draft keeps the fact; for you_number, yes means singular. */
  passWhenYes: boolean
  /** The constraint an active "no" repairs with, when the check builds its own (P13, P9). */
  repair?: string
}

/** What a check makes of one cell: settled in code, a question for Jev, or nothing to ask. */
export type Candidate = { decided: "pass" } | { ask: Omit<Pending, "cell" | "index"> } | null

/** The questions' wording, shared with the shadow eval (scripts/jev-shadow-eval.ts, AQU-1701) so it asks what production asks. */
export const BIBLE_QA_PROMPTS = {
  speaker: (name: string) => `In this translation, are the quoted words spoken by ${name}?`,
  question: "Is this sentence still a question?",
  negation: "Is this statement negative?",
  you_number: "Is 'you' here addressed to one person?",
} as const

function speakerCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  const verbs = profile.speechVerbs ?? []
  if (verbs.length === 0) return null
  const speech = cell.facts?.speeches.find((s) => s.opens && !s.selfProjected && s.speaker)
  if (!speech?.speaker) return null
  const name = nameOf(speech.speaker)
  if (containsTerm(cell.text, name) && verbs.some((verb) => containsTerm(cell.text, verb))) return { decided: "pass" }
  return { ask: { check: "speaker", question: BIBLE_QA_PROMPTS.speaker(name), passWhenYes: true } }
}

function questionCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  if (!cell.expectation?.question.expected) return null
  // With question markers in the profile the M1 gate decides in code.
  if (!isBibleCheckDormant("bkp:M1", profile)) return null
  if (QUESTION_MARK.test(cell.text)) return { decided: "pass" }
  return { ask: { check: "question", question: BIBLE_QA_PROMPTS.question, passWhenYes: true } }
}

function negationCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  if (!cell.facts || cell.facts.negators === 0) return null
  if ((profile.negators ?? []).some((negator) => containsTerm(cell.text, negator))) return { decided: "pass" }
  return { ask: { check: "negation", question: BIBLE_QA_PROMPTS.negation, passWhenYes: true } }
}

function youNumberCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  const number = cell.facts?.secondPerson
  if (number !== "singular" && number !== "plural") return null
  const second = profile.pronouns?.secondPerson
  if (!second?.numberDistinction) return null
  // With forms listed, this is a code check for a later slice, not a question.
  if ((second.singular?.length ?? 0) > 0 || (second.plural?.length ?? 0) > 0) return null
  return {
    ask: { check: "you_number", question: BIBLE_QA_PROMPTS.you_number, passWhenYes: number === "singular" },
  }
}

const CANDIDATES: Readonly<Record<BibleQaCellCheck, (cell: JudgeCell, profile: LanguageProfile) => Candidate>> = {
  speaker: speakerCandidate,
  question: questionCandidate,
  negation: negationCandidate,
  you_number: youNumberCandidate,
  referent: referentCandidate,
  we_inclusive: weInclusiveCandidate,
  introduced: introducedCandidate,
}

// ── Jev ─────────────────────────────────────────────────────────────────────

function clip(text: string): string {
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text
}

function cacheKey(cell: JudgeCell, check: BibleQaCheck, packVersion: string): string {
  return `${promptFingerprint(`${cell.source}\u0000${cell.text}`)}|${check}|${packVersion}`
}

/** An answer's outcome. Exported for C1 (./judge-comprehension.ts), which judges the same way. */
export function outcomeOf(p: number, passWhenYes: boolean): Pick<Judgment, "outcome" | "certainty"> {
  const certainty = Math.abs(p - 0.5) * 2
  if (certainty < BIBLE_QA_ABSTAIN_BELOW) return { outcome: "abstain", certainty }
  const yes = p >= 0.5
  return { outcome: yes === passWhenYes ? "pass" : "fail", certainty }
}

/** The outcome, and on a failure the question's own repair constraint. */
function answerOf(p: number, ask: Pick<Pending, "passWhenYes" | "repair">): Pick<Judgment, "outcome" | "certainty" | "repair"> {
  const outcome = outcomeOf(p, ask.passWhenYes)
  return outcome.outcome === "fail" && ask.repair ? { ...outcome, repair: ask.repair } : outcome
}

/**
 * The batched request for questions about `cells`: each asked cell once in
 * the state (clipped), each question naming its cell. Exported so the shadow
 * eval (scripts/jev-shadow-eval.ts, AQU-1701) sends what production sends.
 */
export function bibleQaRequest(
  cells: readonly Pick<JudgeCell, "ref" | "source" | "text" | "factsLine">[],
  asks: readonly { key: string; index: number; question: string }[],
): { state: { cells: Record<string, unknown>[] }; questions: Record<string, JevQuestion> } {
  const questions: Record<string, JevQuestion> = {}
  for (const ask of asks) {
    questions[ask.key] = {
      type: "noul",
      instructions: { cell: `cell ${ask.index}`, question: ask.question },
      criteria: { true: "Yes: the translation says so.", false: "No: the translation does not say so." },
    }
  }
  const asked = [...new Set(asks.map((ask) => ask.index))]
  const state = {
    cells: asked.map((index) => ({
      index,
      ref: cells[index].ref,
      source: clip(cells[index].source),
      translation: clip(cells[index].text),
      ...(cells[index].factsLine ? { facts: clip(cells[index].factsLine ?? "") } : {}),
    })),
  }
  return { state, questions }
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
  const modes = { ...BIBLE_QA_MODES, ...deps.modes }
  const judgments: Judgment[] = []
  const pending: Pending[] = []
  cells.forEach((cell, index) => {
    for (const check of BIBLE_QA_CELL_CHECKS) {
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
          ...answerOf(cached, candidate.ask),
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
  const { state, questions } = bibleQaRequest(
    cells,
    pending.map((q) => ({ key: keyOf(q), index: q.index, question: q.question })),
  )
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
      ...answerOf(p, q),
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

/**
 * The templated English constraint for an active failure, from the cell's
 * facts; null for a question whose "no" is a finding to review, never a
 * repair (AQU-1701): an introduction (P11) is advisory, and a Translation
 * Question (C1) never redrafts.
 */
export function judgmentConstraint(judgment: Pick<Judgment, "check" | "repair">, facts: CellFacts | undefined): string | null {
  const speech = facts?.speeches.find((s) => s.opens && !s.selfProjected && s.speaker)
  switch (judgment.check) {
    case "referent":
    case "we_inclusive":
      return judgment.repair ?? null
    case "introduced":
    case "tq":
      return null
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
