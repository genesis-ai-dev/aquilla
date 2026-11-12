// bible-fact-questions — ask for a Language-profile slot the pack needs
// (AQU-1690, through AQU-1691's fact questions).
//
// The Bible data checks wait on profile slots: no quotation checks without
// `quoteMarks`, no question check without `questionMarkers`, no "you"
// singular/plural facts without `pronouns.secondPerson`. When a file's pack
// data shows the slot matters (quoted speech, questions, second-person forms)
// and the project has not filled it, autopilot asks — ONCE per run per slot,
// as a fact question raised with runId: null, so the run never parks on it.
// The answer becomes a durable fact (AQU-1691) that every later run uses. A
// later run that raises the same question supersedes the open one (the
// helper's fact branch), so the card always carries the current wording.

import type { AquillaDb } from "../../../../db/shim/postgres"
import type { DecisionOption } from "../../../../db/shared/contextual-decisions"
import type { QuoteMarksProfile } from "../../../../db/shared/language-profile"
import type { BibleRunData } from "./bible-run"
import { raiseFactQuestion } from "./fact-questions"

export interface BibleFactQuestion {
  factKey: "quoteMarks" | "questionMarkers" | "pronouns.secondPerson"
  reason: string
  options: DecisionOption[]
  /** A few of the cells that need the answer, for the card's context. */
  cellIds: string[]
  /** How many cells of the file need it. */
  blastRadius: number
}

const EXAMPLE_CELLS = 5

function quoteMarks(levels: [string, string][], continuation: QuoteMarksProfile["continuation"]): string {
  const value: QuoteMarksProfile = { levels: levels.map(([open, close]) => ({ open, close })), continuation }
  return JSON.stringify(value)
}

/** One-click answers, seeded from common conventions (CLDR delimiters; see src/lib/bible-data/quote-mark-defaults.ts). */
const QUOTE_MARK_OPTIONS: DecisionOption[] = [
  { value: quoteMarks([["“", "”"], ["‘", "’"]], "reopen-each-paragraph"), label: "“ ” then ‘ ’ (English)" },
  { value: quoteMarks([["«", "»"], ["“", "”"]], "reopen-each-paragraph"), label: "« » then “ ” (French)" },
  { value: quoteMarks([["«", "»"], ["“", "”"], ["‘", "’"]], "continuation-mark"), label: "« » then “ ” then ‘ ’ (Spanish)" },
  { value: quoteMarks([["„", "“"], ["‚", "‘"]], "reopen-each-paragraph"), label: "„ “ then ‚ ‘ (German)" },
]

/** The slots this file's Bible data needs and the profile lacks. Pure. */
export function bibleFactQuestions(data: BibleRunData): BibleFactQuestion[] {
  const profile = data.profile
  const speech: string[] = []
  const questions: string[] = []
  const secondPerson: string[] = []
  for (const [cellId, facts] of data.facts) {
    if (facts.speeches.some((s) => s.level >= 1 && !s.selfProjected)) speech.push(cellId)
    if (facts.question) questions.push(cellId)
    if (facts.secondPerson) secondPerson.push(cellId)
  }
  const out: BibleFactQuestion[] = []
  if (!profile.quoteMarks && speech.length > 0) {
    out.push({
      factKey: "quoteMarks",
      reason:
        "Bible data shows quoted speech in this book, but the Language profile does not say which quotation marks your language uses. Choose them, and autopilot checks every quotation it drafts.",
      options: QUOTE_MARK_OPTIONS,
      cellIds: speech.slice(0, EXAMPLE_CELLS),
      blastRadius: speech.length,
    })
  }
  if (!profile.questionMarkers && questions.length > 0) {
    out.push({
      factKey: "questionMarkers",
      reason:
        "Bible data shows questions in this book. Does your language mark a question only with a question mark? If it also uses a word or an ending, add it in the Language profile. Then autopilot checks that each question stays a question.",
      options: [{ value: "{}", label: "Only a question mark" }],
      cellIds: questions.slice(0, EXAMPLE_CELLS),
      blastRadius: questions.length,
    })
  }
  if (!profile.pronouns?.secondPerson && secondPerson.length > 0) {
    out.push({
      factKey: "pronouns.secondPerson",
      reason:
        "In this book the Greek “you” is sometimes one person and sometimes several. Does your language use a different “you” for one person and for several? Autopilot then keeps the right one in every draft.",
      options: [
        { value: JSON.stringify({ numberDistinction: true }), label: "Yes: one “you” for one person, another for several" },
        { value: JSON.stringify({ numberDistinction: false }), label: "No: the same “you” for one person or many" },
      ],
      cellIds: secondPerson.slice(0, EXAMPLE_CELLS),
      blastRadius: secondPerson.length,
    })
  }
  return out
}

/**
 * Raise each needed question once per run (`raised` lasts the run). Never
 * throws: a question that cannot be raised costs a card, never the wave.
 * Returns the keys raised now.
 */
export async function raiseBibleFactQuestions(
  db: AquillaDb,
  input: { projectId: string; fileId: string; data: BibleRunData; raised: Set<string> },
): Promise<string[]> {
  const raisedNow: string[] = []
  for (const question of bibleFactQuestions(input.data)) {
    if (input.raised.has(question.factKey)) continue
    input.raised.add(question.factKey)
    try {
      const result = await raiseFactQuestion(db, {
        projectId: input.projectId,
        factKey: question.factKey,
        reason: question.reason,
        options: question.options,
        fileId: input.fileId,
        cellIds: question.cellIds,
        blastRadius: question.blastRadius,
      })
      if (result.status === "raised") raisedNow.push(question.factKey)
      else if (result.status === "invalid") console.warn(`[bible-facts] ${question.factKey} not raised: ${result.reason}`)
    } catch (err) {
      console.warn(`[bible-facts] ${question.factKey} not raised:`, err instanceof Error ? err.message : err)
    }
  }
  return raisedNow
}
