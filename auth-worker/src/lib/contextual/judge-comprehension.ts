// judge-comprehension — C1: Translation Questions as an automated
// comprehension check (AQU-1701; design doc §7.8 C1, §9.3 `tq`).
//
// unfoldingWord's Translation Questions are what a community checker asks a
// reader of a draft: "What was the Word?" — "The Word was God." For each TQ
// whose WHOLE verse range has target text, Jev is asked whether the
// translation says the answer: one noul question per TQ, one batched
// decide() per chapter (at most MAX_TQ_PER_CALL questions a call). A range
// with a verse that has no text yet is skipped, never half-asked.
//
//   autopilot   after a span's drafting is settled, over its final drafts and
//               the committed text around them; a TQ is asked when its range
//               touches a draft. A "no" never redrafts: it is a finding for a
//               person to review (./pipeline.ts).
//   check mode  over translated cells, as an automated community check. A TQ
//               belongs to the call that checks its first verse, so a range
//               across two calls is asked once (./bible-check-mode.ts).
//
// SHADOW BY DEFAULT (BIBLE_QA_MODES.tq): answers are traced for maintainers
// and act on nothing. Active, a confident "no" is a `bkp:C1` finding (info)
// on the first checked cell of the range, with the question and its answer
// as evidence. Below certainty 0.4 an answer abstains, as does every answer
// when Jev is off, capped or down. Answers are cached by (passage text, TQ,
// pack version).
//
// The Jev state carries each passage once, clipped, and each question names
// its passage: a verse that three TQs ask about is sent once.

import type { BkpQuestion } from "../bkp/pack-types"
import type { DecideResult, JevAnswer, JevQuestion } from "../jev/decide"
import { promptFingerprint } from "./draft"
import { BIBLE_QA_MODES, outcomeOf, type BibleQaDecide, type BibleQaMode, type BibleQaTrace, type Judgment } from "./judge-expectations"

/** Questions in one decide() call. A chapter has at most 67 TQs (PSA 119), most fewer than 40. */
export const MAX_TQ_PER_CALL = 40
const PASSAGE_MAX = 1000
const ANSWER_MAX = 400

export interface ComprehensionCell {
  cellId: string
  /** The pack verses the cell covers ("JHN 4:7"), from its compiled expectation. */
  refs: readonly string[]
  text: string
}

export interface TqJudgment extends Judgment {
  check: "tq"
  /** The Translation Question ("tq:172799"); `cellId` is the cell an active "no" lands on. */
  tq: string
  refs: readonly string[]
}

export interface ComprehensionFinding {
  cellId: string
  code: "bkp:C1"
  /** The evidence the review chips show: the question, its answer and its verses. */
  params: Record<string, string>
}

export interface ComprehensionResult {
  judgments: TqJudgment[]
  /** ACTIVE "no" answers only, one per cell. Shadow answers never make one. */
  findings: ComprehensionFinding[]
  jevCalls: number
}

export interface ComprehensionInput {
  questions: readonly BkpQuestion[]
  /** Cells with target text, in file order: drafts and committed text alike. */
  cells: readonly ComprehensionCell[]
  /** The cells this pass checks: autopilot's drafts, or check mode's batch. */
  checked: ReadonlySet<string>
  /** "touches": asked when any cell of the range is checked; "first-verse": only when the first verse's cell is. */
  owner: "touches" | "first-verse"
  /** The trace row's span: the autopilot span, or the check-mode call. */
  traceSpanId: string
}

export interface ComprehensionDeps {
  packVersion: string
  decide: BibleQaDecide
  /** p(yes) per (passage text, TQ, pack version), kept for the run. */
  cache: Map<string, number>
  record?: (trace: BibleQaTrace) => void
  /** Test seam; production reads BIBLE_QA_MODES.tq. */
  mode?: BibleQaMode
}

interface Asked {
  tq: BkpQuestion
  /** The cell an active "no" lands on. */
  anchor: string
  /** The passage: the cells covering the range, in order. */
  passageKey: string
  passage: string
  chapter: string
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** "JHN 4:7", or "JHN 4:7–9" for a range in one chapter. */
export function refsLabel(refs: readonly string[]): string {
  if (refs.length === 1) return refs[0]
  const first = refs[0]
  const last = refs[refs.length - 1]
  const chapter = (ref: string) => ref.replace(/:\d+$/u, "")
  return chapter(first) === chapter(last) ? `${first}–${last.slice(last.lastIndexOf(":") + 1)}` : refs.join(", ")
}

/** The TQs this pass asks: whole range translated, and owned per `owner`. */
function askedQuestions(input: ComprehensionInput): Asked[] {
  const byVerse = new Map<string, string[]>()
  const textOf = new Map<string, string>()
  for (const cell of input.cells) {
    if (!cell.text.trim()) continue
    textOf.set(cell.cellId, cell.text.trim())
    for (const ref of cell.refs) byVerse.set(ref, [...(byVerse.get(ref) ?? []), cell.cellId])
  }
  const out: Asked[] = []
  for (const tq of input.questions) {
    const perVerse: string[][] = []
    for (const ref of tq.refs) {
      const ids = byVerse.get(ref)
      if (!ids) break
      perVerse.push(ids)
    }
    // A verse of the range has no text yet: the answer may sit in the part not written.
    if (perVerse.length !== tq.refs.length) continue
    const cellIds = [...new Set(perVerse.flat())]
    const anchor = input.owner === "first-verse"
      ? (input.checked.has(perVerse[0][0]) ? perVerse[0][0] : undefined)
      : cellIds.find((id) => input.checked.has(id))
    if (!anchor) continue
    out.push({
      tq,
      anchor,
      passageKey: cellIds.join("\u0001"),
      passage: cellIds.map((id) => textOf.get(id) ?? "").join(" "),
      chapter: tq.refs[0].replace(/:\d+$/u, ""),
    })
  }
  return out
}

function cacheKey(asked: Asked, packVersion: string): string {
  return `${promptFingerprint(asked.passage)}|${asked.tq.id}|${packVersion}`
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** "The Word was God." → "The Word was God": the question supplies its own "?". */
function answerClause(answer: string): string {
  return clip(answer.trim().replace(/[.。]+$/u, ""), ANSWER_MAX)
}

/** One batched call for up to MAX_TQ_PER_CALL questions of one chapter. Never throws. */
async function askChapter(
  chapter: string,
  pending: readonly Asked[],
  deps: ComprehensionDeps,
  traceSpanId: string,
  mode: BibleQaMode,
): Promise<TqJudgment[]> {
  const passages = new Map<string, number>()
  const statePassages: { passage: number; refs: string; translation: string }[] = []
  const questions: Record<string, JevQuestion> = {}
  pending.forEach((asked, i) => {
    let index = passages.get(asked.passageKey)
    if (index === undefined) {
      index = statePassages.length
      passages.set(asked.passageKey, index)
      statePassages.push({ passage: index, refs: refsLabel(asked.tq.refs), translation: clip(asked.passage, PASSAGE_MAX) })
    }
    questions[`q${i}`] = {
      type: "noul",
      instructions: {
        passage: `passage ${index}`,
        question: `Given this translation of ${refsLabel(asked.tq.refs)} (passage ${index}): does the translation say that ${answerClause(asked.tq.a)}?`,
      },
      criteria: { true: "Yes: the translation says this.", false: "No: the translation does not say this, or says something else." },
    }
  })
  const state = { chapter, passages: statePassages }
  // An unanswered question is p = 0.5: certainty 0, so it abstains.
  const fallback = (): Record<string, JevAnswer> => Object.fromEntries(pending.map((_, i) => [`q${i}`, { kind: "noul", p: 0.5 } as JevAnswer]))
  const started = Date.now()
  let result: DecideResult
  try {
    result = await deps.decide({ state, questions, fallback })
  } catch (err) {
    console.warn("[bible-qa] C1 decide failed; every question abstains:", err instanceof Error ? err.message : err)
    result = { answers: fallback(), decidedBy: "heuristic", reason: "upstream", model: null, usage: null }
  }
  const judgments: TqJudgment[] = pending.map((asked, i) => {
    const answer = result.answers[`q${i}`]
    const p = answer?.kind === "noul" ? answer.p : 0.5
    const answered = result.decidedBy !== "heuristic" && p !== 0.5
    if (answered) deps.cache.set(cacheKey(asked, deps.packVersion), p)
    return {
      cellId: asked.anchor,
      check: "tq",
      ...outcomeOf(p, true),
      decidedBy: answered ? "jev" : "fallback",
      mode,
      ...(answered ? { p } : {}),
      tq: asked.tq.id,
      refs: asked.tq.refs,
    }
  })
  deps.record?.({ spanId: traceSpanId, request: { state, questions }, result, judgments, latencyMs: Date.now() - started })
  return judgments
}

/**
 * Ask the Translation Questions this pass owns, one batched call per chapter.
 * Never throws: a Jev failure is an abstention.
 */
export async function judgeComprehension(input: ComprehensionInput, deps: ComprehensionDeps): Promise<ComprehensionResult> {
  const mode = deps.mode ?? BIBLE_QA_MODES.tq
  const judgments: TqJudgment[] = []
  const byChapter = new Map<string, Asked[]>()
  for (const asked of askedQuestions(input)) {
    const cached = deps.cache.get(cacheKey(asked, deps.packVersion))
    if (cached !== undefined) {
      judgments.push({
        cellId: asked.anchor,
        check: "tq",
        ...outcomeOf(cached, true),
        decidedBy: "cache",
        mode,
        p: cached,
        tq: asked.tq.id,
        refs: asked.tq.refs,
      })
      continue
    }
    byChapter.set(asked.chapter, [...(byChapter.get(asked.chapter) ?? []), asked])
  }
  let jevCalls = 0
  for (const [chapter, pending] of byChapter) {
    for (const batch of chunks(pending, MAX_TQ_PER_CALL)) {
      judgments.push(...(await askChapter(chapter, batch, deps, input.traceSpanId, mode)))
      jevCalls += 1
    }
  }
  return { judgments, findings: comprehensionFindings(judgments, input.questions), jevCalls }
}

/** The active failures as findings: one per cell, with the first failing question as its evidence and a count of the rest. */
function comprehensionFindings(judgments: readonly TqJudgment[], questions: readonly BkpQuestion[]): ComprehensionFinding[] {
  const byId = new Map(questions.map((q) => [q.id, q]))
  const failed = new Map<string, TqJudgment[]>()
  for (const j of judgments) {
    if (j.mode !== "active" || j.outcome !== "fail") continue
    failed.set(j.cellId, [...(failed.get(j.cellId) ?? []), j])
  }
  return [...failed].flatMap(([cellId, list]) => {
    const tq = byId.get(list[0].tq)
    if (!tq) return []
    const params: Record<string, string> = {
      kind: "answer-missing",
      evidence: "translation-question",
      tq: tq.id,
      refs: tq.refs.join(","),
      question: tq.q,
      answer: tq.a,
      ...(list.length > 1 ? { more: String(list.length - 1) } : {}),
    }
    return [{ cellId, code: "bkp:C1" as const, params }]
  })
}
