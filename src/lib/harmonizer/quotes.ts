// Textual metafunction — quotation continuity across cells (AQU-1657).
//
// The case this exists for: John 6:26–27. Jesus's reply opens in v.26 and runs
// to the end of v.27, but the draft of v.27 never closes it. Greek marks no
// quotations, so the source gives the drafting model no punctuation to copy;
// the obligation is in the discourse, and only visible across cells.
//
// plan      Learn the project's primary quotation pair from its own text
//           (validated cells first), then walk the passage tracking whether a
//           quotation is open. A span needs asking when it is BROKEN (a new
//           quotation opens mid-cell while one is still open — the previous one
//           must have ended somewhere without closing) or still OPEN at the end
//           of the passage.
// questions One `choice` per span: in which cell does the speech end? Plus one
//           `noul` per candidate cell: does the speech end at the very end of
//           that cell, with nothing narrated after it?
// findings  Close the quotation at the end of the chosen cell, only when Jev is
//           confident about both the cell and the end-of-cell position. A
//           speech that ends mid-cell ("…," he said) is left alone here: where
//           to put the mark inside the sentence is not something a
//           deterministic rule should guess.

import type { HarmonizerCell, HarmonizerFinding, HarmonizerQuestion, HarmonyCheck } from "./types"

export interface QuotePair {
  open: string
  close: string
}

/** Candidate primary pairs, most common first. Symmetric pairs toggle. */
export const QUOTE_PAIRS: readonly QuotePair[] = [
  { open: "“", close: "”" },
  { open: "«", close: "»" },
  { open: "„", close: "“" },
  { open: "„", close: "”" },
  { open: "»", close: "«" },
  { open: "「", close: "」" },
  { open: "『", close: "』" },
  { open: "‘", close: "’" },
  { open: "\"", close: "\"" },
]

function count(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n++
  return n
}

/** Complete pairs count double; a lone opening mark still counts, so a
 *  passage whose only quotation is the unclosed one still learns its pair. */
function pairScore(texts: readonly string[], pair: QuotePair): number {
  const joined = texts.join("\n")
  const opens = count(joined, pair.open)
  if (pair.open === pair.close) return opens
  return 2 * Math.min(opens, count(joined, pair.close)) + (opens > 0 ? 1 : 0)
}

/**
 * The quotation pair this project actually uses. Validated cells decide when
 * any of them quote; otherwise whatever the passage itself uses. A project
 * that has not quoted anything yet gets null — there is no realisation to be
 * consistent with, and inventing one is the model's job, not the checker's.
 */
export function learnQuotePair(cells: readonly HarmonizerCell[]): QuotePair | null {
  const pick = (texts: readonly string[]): QuotePair | null => {
    let best: QuotePair | null = null
    let bestScore = 0
    for (const pair of QUOTE_PAIRS) {
      const s = pairScore(texts, pair)
      if (s > bestScore) {
        best = pair
        bestScore = s
      }
    }
    return best
  }
  const validated = cells.filter((c) => c.validated).map((c) => c.target)
  return pick(validated) ?? pick(cells.map((c) => c.target))
}

export interface QuoteSpan {
  /** Index into the passage of the cell where the quotation opens. */
  startCell: number
  /** Cells that could hold the end of the speech, in order. */
  candidates: number[]
  /** true: a later quotation opened while this one was still open. */
  broken: boolean
}

/** At the start of a cell (ignoring whitespace) — the continued-paragraph
 *  convention re-opens a quotation there without closing the previous one. */
function atCellStart(text: string, offset: number): boolean {
  return text.slice(0, offset).trim() === ""
}

/** Spans that need asking: broken, or still open at the end of the passage. */
export function findQuoteSpans(
  cells: readonly HarmonizerCell[],
  pair: QuotePair,
  maxCandidates = MAX_CANDIDATES_PER_SPAN,
): QuoteSpan[] {
  const spans: QuoteSpan[] = []
  let openAt: number | null = null
  const symmetric = pair.open === pair.close

  const closeSpan = (endBefore: number, broken: boolean) => {
    if (openAt === null) return
    const candidates: number[] = []
    for (let k = openAt; k <= endBefore && candidates.length < maxCandidates; k++) candidates.push(k)
    if (candidates.length > 0) spans.push({ startCell: openAt, candidates, broken })
    openAt = null
  }

  cells.forEach((cell, i) => {
    const text = cell.target
    for (let offset = 0; offset < text.length; offset++) {
      const ch = text[offset]
      if (symmetric && ch === pair.open) {
        openAt = openAt === null ? i : null
        continue
      }
      if (ch === pair.open) {
        if (openAt === null) openAt = i
        else if (!(i > openAt && atCellStart(text, offset))) {
          // Opened again mid-text while still open: the earlier speech ended
          // before this cell (or before this point in it) without closing.
          closeSpan(i - 1, true)
          openAt = i
        }
      } else if (ch === pair.close && openAt !== null) {
        openAt = null
      }
    }
  })
  if (openAt !== null) closeSpan(cells.length - 1, false)
  return spans
}

/** Upper bounds keep one passage to one cheap Jev call. */
export const MAX_CANDIDATES_PER_SPAN = 12
export const MAX_SPANS = 4
/** Jev must be at least this sure of both the cell and the end-of-cell
 *  position before a mark is suggested. */
export const QUOTE_MIN_PROBABILITY = 0.6

export const CONTINUES = "continues"

export interface QuotePlan {
  pair: QuotePair
  spans: QuoteSpan[]
}

const label = (i: number) => `cell ${i}`
const cellOption = (k: number) => `c${k}`

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

/** The last word of the cell with its trailing punctuation — the span that
 *  gets underlined and receives the closing mark. */
export function closingSpan(target: string): { start: number; end: number } | null {
  const end = target.trimEnd().length
  if (end === 0) return null
  const before = target.slice(0, end)
  const lastSpace = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t"))
  return { start: lastSpace + 1, end }
}

export const quotationCheck: HarmonyCheck<QuotePlan> = {
  id: "textual.quotation",
  metafunction: "textual",

  plan(cells) {
    const pair = learnQuotePair(cells)
    if (!pair) return null
    // Only BROKEN spans: a quotation still open at the end of the passage is
    // usually a long discourse that runs on past the window, and asking Jev
    // where it ends produced most of this check's false alarms on clean text
    // (harmonizer eval, BSB + Macula, 2026-10-05). A broken span has proof the
    // speech ended — a new one opened.
    const spans = findQuoteSpans(cells, pair).filter((s) => s.broken).slice(0, MAX_SPANS)
    return spans.length > 0 ? { pair, spans } : null
  },

  questions(plan, prefix) {
    const out: Record<string, HarmonizerQuestion> = {}
    plan.spans.forEach((span, s) => {
      const criteria: Record<string, string> = {}
      for (const k of span.candidates) {
        criteria[cellOption(k)] = `The speech that begins in ${label(span.startCell)} ends in ${label(k)}.`
      }
      if (!span.broken) {
        criteria[CONTINUES] = "The speech is still going at the end of the last cell shown."
      }
      out[`${prefix}s${s}`] = {
        type: "choice",
        instructions: {
          speech_starts_in: label(span.startCell),
          question:
            "Read the SOURCE of these cells. Direct speech (someone's quoted words) begins in the named cell. In which cell does that same speaker's direct speech end?",
        },
        criteria,
      }
      for (const k of span.candidates) {
        out[`${prefix}s${s}_end${k}`] = {
          type: "noul",
          instructions: {
            cell: label(k),
            question:
              "Read the SOURCE of this cell. If direct speech ends in it, does it end at the very end of the cell, with no narration after it?",
          },
          criteria: {
            true: "The quoted words run right to the end of the cell.",
            false: "Narration follows the quoted words in this cell, or no speech ends here.",
          },
        }
      }
    })
    return out
  },

  findings(plan, cells, answers, prefix, opts) {
    const min = opts?.minProbability ?? QUOTE_MIN_PROBABILITY
    const out: HarmonizerFinding[] = []
    plan.spans.forEach((span, s) => {
      const picked = choiceValue(answers[`${prefix}s${s}`])
      if (!picked || picked.choice === CONTINUES || picked.probability < min) return
      const m = /^c(\d+)$/.exec(picked.choice)
      if (!m) return
      const k = Number(m[1])
      if (!span.candidates.includes(k)) return
      const atEnd = noulValue(answers[`${prefix}s${s}_end${k}`])
      if (atEnd === undefined || atEnd < min) return
      const cell = cells[k]
      const range = cell && closingSpan(cell.target)
      if (!range) return
      const old = cell.target.slice(range.start, range.end)
      out.push({
        checkId: quotationCheck.id,
        metafunction: "textual",
        cellId: cell.id,
        start: range.start,
        end: range.end,
        old,
        new: old + plan.pair.close,
        reasonKey: "harmonizer.quotes.closeHere",
        reasonValues: { openedIn: cells[span.startCell]?.ref ?? label(span.startCell) },
        confidence: Math.min(picked.probability, atEnd),
      })
    })
    return out
  },
}
