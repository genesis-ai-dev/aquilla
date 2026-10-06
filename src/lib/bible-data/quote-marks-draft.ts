// The "Language profile for checks" card's form state (AQU-1688). Pure.
//
// The card always shows three rows; the stored slot keeps only the levels the
// project uses. A deeper level is optional, but it needs both marks, and
// level 3 needs level 2.

import {
  MAX_QUOTE_LEVELS,
  languageProfileProblem,
  type QuoteContinuationStyle,
  type QuoteMarksProfile,
} from "../../../db/shared/language-profile"

export interface QuoteMarksDraft {
  /** Always MAX_QUOTE_LEVELS rows; an unused row is two empty strings. */
  levels: { open: string; close: string }[]
  continuation: QuoteContinuationStyle
}

export function draftFromQuoteMarks(quoteMarks: QuoteMarksProfile | null | undefined): QuoteMarksDraft {
  return {
    levels: Array.from({ length: MAX_QUOTE_LEVELS }, (_, i) => ({
      open: quoteMarks?.levels[i]?.open ?? "",
      close: quoteMarks?.levels[i]?.close ?? "",
    })),
    continuation: quoteMarks?.continuation ?? "reopen-each-paragraph",
  }
}

/** The slot to store, or null when the draft cannot be saved as it is. */
export function quoteMarksFromDraft(draft: QuoteMarksDraft): QuoteMarksProfile | null {
  const rows = draft.levels.map(({ open, close }) => ({ open: open.trim(), close: close.trim() }))
  const used = rows.map((row) => row.open !== "" || row.close !== "")
  const count = used.lastIndexOf(true) + 1
  if (count === 0) return null
  // No gaps: level 3 needs level 2, and every used row needs both marks.
  const levels = rows.slice(0, count)
  if (levels.some((row) => row.open === "" || row.close === "")) return null
  const quoteMarks: QuoteMarksProfile = { levels, continuation: draft.continuation }
  return languageProfileProblem({ quoteMarks }) === null ? quoteMarks : null
}
