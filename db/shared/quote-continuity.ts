// Quotation continuity across cells (AQU-1733).
//
// A quotation that opens in one cell and is never closed is invisible to every
// per-cell check. Each cell on its own looks fine: the cell that opens the
// speech has one mark, the cells that continue it have none, and the LQA
// `unpaired-quotes` check deliberately goes quiet whenever the SOURCE carries
// the same imbalance — which a Greek or Hebrew source always does, because it
// marks no quotations at all. The obligation only exists across the cells.
//
// That verdict cannot live in the rule engine's per-cell path: `checkRulesForCell`
// is pure per cell, which is what makes the incremental scan sound (a keystroke
// in one cell must never re-evaluate another — src/lib/rules/incremental-infractions.ts).
// So this is a FILE-level pass, like the Bible data scans (AQU-1697), run by
// "Check file" over the whole file in reading order.
//
// Deterministic throughout: the project's own marks (the Language profile's
// `quoteMarks` slot, or `inferQuoteMarks` reading them off the project's text),
// then `scanQuotes` per cell with the previous cell's `finalDepth` as its
// `startDepth`, and a stack that remembers where each still-open level opened.
// No model, no network, no feature flag — unlike the harmonizer's quotation
// check (src/lib/harmonizer/quotes.ts), which asks Jev which cell a speech ends
// in and therefore needs the `harmonizer` flag.
//
// Relative imports only, no DOM: shared with the workers.

import { scanQuotes } from './bible-checks/quote-scan'
import type { QuoteMarksProfile } from './language-profile'

/** What the pass reads from one cell. A `CellData` or a worker row fits. */
export interface QuoteContinuityCell {
  id: string
  /** The target text, as the reader sees it. */
  text: string
}

/** A quotation that the text never closes. */
export interface UnclosedQuotation {
  /** The cell whose text opens it. */
  cellId: string
  /** That cell's index in the scanned order. */
  cellIndex: number
  /** Offsets of the opening mark in that cell's text (UTF-16, end exclusive). */
  start: number
  end: number
  /** 1 = outermost. */
  depth: number
  /** The opening mark, as the text wrote it. */
  open: string
  /** The mark that would close it, per the project's marks. */
  close: string
  /**
   * How many later cells the quotation stayed open for. 0 means it opened and
   * ran out inside one cell; 1 or more is the cross-cell case the per-cell
   * checks cannot see.
   */
  cellsOpen: number
}

/** A closing mark with no quotation open for it to close. */
export interface StrayQuoteClose {
  cellId: string
  cellIndex: number
  start: number
  end: number
  /** The closing mark, as the text wrote it. */
  close: string
}

/** Where one quotation mark sits. */
export interface QuoteMarkPlace {
  cellId: string
  start: number
  end: number
}

export interface QuoteContinuityResult {
  unclosed: UnclosedQuotation[]
  strays: StrayQuoteClose[]
  /**
   * Every mark the walk accounted for: an opening mark that a later cell does
   * close, its closing mark, and the marks that only reopen a quotation at a
   * paragraph. These are the marks a per-cell check sees in isolation and
   * cannot pair — a closing mark alone in its cell looks unpaired to
   * `unpaired-quotes`, and for a source that marks no quotations (Greek,
   * Hebrew) its source comparison cannot rescue it. Reported so the caller can
   * withdraw that false alarm.
   */
  matched: QuoteMarkPlace[]
}

/**
 * At most this many still-open levels are reported for one scan. A draft that
 * opens a new speech per verse without ever closing one would otherwise report
 * a finding per level, which says the same thing many times over; the
 * outermost levels are the ones a reviewer fixes first.
 */
export const MAX_UNCLOSED_REPORTED = 3

const EMPTY: QuoteContinuityResult = { unclosed: [], strays: [], matched: [] }

interface OpenMark {
  cellId: string
  cellIndex: number
  start: number
  end: number
  depth: number
  /** The profile level whose marks it used (1-based). */
  set: number
  open: string
}

/**
 * The quotations left open, and the stray closing marks, across `cells` in
 * reading order.
 *
 * An **untranslated cell ends the evidence**: a quotation still open where the
 * translation stops may well be closed in the text that is not written yet, so
 * the pending marks are dropped rather than reported. Without that, every
 * half-translated file would report its whole quoted discourse as broken.
 */
export function scanQuoteContinuity(
  cells: readonly QuoteContinuityCell[],
  marks: QuoteMarksProfile | null | undefined,
): QuoteContinuityResult {
  if (!marks || marks.levels.length === 0 || cells.length === 0) return EMPTY

  const strays: StrayQuoteClose[] = []
  const matched: QuoteMarkPlace[] = []
  let open: OpenMark[] = []
  let lastScanned = -1

  cells.forEach((cell, cellIndex) => {
    if (cell.text.trim() === '') {
      // A gap in the evidence, not a broken quotation.
      open = []
      return
    }
    const { tokens, finalDepth } = scanQuotes(cell.text, marks, open.length)
    for (const token of tokens) {
      if (token.kind === 'open') {
        open.push({
          cellId: cell.id,
          cellIndex,
          start: token.start,
          end: token.end,
          depth: token.depth,
          set: token.set,
          open: cell.text.slice(token.start, token.end),
        })
        continue
      }
      if (token.kind === 'close') {
        // A closing mark closes its level and everything nested inside it.
        matched.push({ cellId: cell.id, start: token.start, end: token.end })
        while (open.length > 0 && open[open.length - 1].depth >= token.depth) {
          const closed = open.pop()
          if (closed) matched.push({ cellId: closed.cellId, start: closed.start, end: closed.end })
        }
        continue
      }
      if (token.kind === 'continuation') {
        // Neither opens nor closes: the same quotation, reopened at a paragraph.
        matched.push({ cellId: cell.id, start: token.start, end: token.end })
        continue
      }
      if (token.kind === 'stray-close') {
        strays.push({
          cellId: cell.id,
          cellIndex,
          start: token.start,
          end: token.end,
          close: cell.text.slice(token.start, token.end),
        })
      }
    }
    // Stay in step with the scanner's own depth: it, not this stack, is what
    // the next cell is scanned against.
    while (open.length > finalDepth) open.pop()
    lastScanned = cellIndex
  })

  const unclosed = open.slice(0, MAX_UNCLOSED_REPORTED).map((mark): UnclosedQuotation => ({
    cellId: mark.cellId,
    cellIndex: mark.cellIndex,
    start: mark.start,
    end: mark.end,
    depth: mark.depth,
    open: mark.open,
    close: marks.levels[mark.set - 1]?.close ?? '',
    cellsOpen: Math.max(0, lastScanned - mark.cellIndex),
  }))

  return { unclosed, strays, matched }
}
