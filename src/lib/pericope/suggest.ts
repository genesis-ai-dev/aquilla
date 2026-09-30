import {
  compareAddresses,
  formatRef,
  type PericopeIndex,
  type PericopeSection,
  type VerseAddress,
} from "./sections"

/** How many options the editor offers at once unless a caller says otherwise. */
export const DEFAULT_SUGGESTION_LIMIT = 4

export interface PericopeSuggestion {
  /** Stable within a book — safe as a React key and as a selection token. */
  key: string
  book: string
  start: VerseAddress
  end: VerseAddress
  /** `canonicalRef` spellings, so callers can match cells without re-formatting. */
  startRef: string
  endRef: string
  /** 0–20 — how many surveyed translations draw a section ending here. */
  translations: number
  /**
   * The range was clipped at its front because the resume point sits inside a
   * section rather than on one of its boundaries. The end is still a real
   * boundary; only the start is the user's own position.
   */
  continuation: boolean
}

export interface SuggestOptions {
  /** USFM book code of the file being worked. */
  book: string
  /** Resume from here (inclusive). Defaults to the start of the book. */
  from?: VerseAddress
  limit?: number
}

const BOOK_START: VerseAddress = { chapter: 1, verse: 1 }

function toSuggestion(
  section: PericopeSection,
  start: VerseAddress,
  continuation: boolean,
): PericopeSuggestion {
  return {
    key: `${section.book}:${start.chapter}.${start.verse}-${section.end.chapter}.${section.end.verse}`,
    book: section.book,
    start,
    end: section.end,
    startRef: formatRef(section.book, start),
    endRef: formatRef(section.book, section.end),
    translations: section.translations,
    continuation,
  }
}

/**
 * The next few pericope ranges to offer a translator (AQU-515).
 *
 * Every option shares one start — the point the user is resuming from — and
 * differs in where it ends, which is exactly the shape of the OpenBible
 * dataset: several surveyed translations agree on a section beginning at a
 * verse but disagree on how far it runs. Ranking by `translations` puts the
 * boundary most Bibles land on first.
 *
 * Three cases, in order:
 *
 * 1. **On a boundary** — sections start exactly at `from`. Offer those.
 * 2. **Mid-section** — no section starts at `from`, but sections span it. Offer
 *    those clipped to begin at `from`, so finishing one lands the translator on
 *    a real boundary rather than sending them back over work already done.
 * 3. **Past the last boundary** (or a gap the dataset does not cover) — fall
 *    forward to the nearest section starting after `from`.
 *
 * A book the dataset does not carry, or a file with no scripture addresses at
 * all, yields an empty list — never an error. Non-Bible files fall through to
 * the Jev-derived passages of AQU-1387 once that ships.
 */
export function suggestPericopes(
  index: PericopeIndex,
  { book, from, limit = DEFAULT_SUGGESTION_LIMIT }: SuggestOptions,
): PericopeSuggestion[] {
  if (limit <= 0) return []
  const sections = index.get(book.toUpperCase())
  if (!sections?.length) return []

  const anchor = from ?? BOOK_START

  const exact = sections.filter((section) => compareAddresses(section.start, anchor) === 0)
  const candidates = exact.length > 0
    ? exact.map((section) => toSuggestion(section, anchor, false))
    : spanning(sections, anchor)

  const resolved = candidates.length > 0 ? candidates : fallForward(sections, anchor)

  // Two sections can share an end once a mid-section clip erases the different
  // starts that told them apart; keep the strongest of each end.
  const seen = new Set<string>()
  const unique: PericopeSuggestion[] = []
  for (const suggestion of resolved) {
    if (seen.has(suggestion.endRef)) continue
    seen.add(suggestion.endRef)
    unique.push(suggestion)
    if (unique.length === limit) break
  }
  return unique
}

/** Case 2 — sections that contain `anchor`, clipped to start there. */
function spanning(
  sections: readonly PericopeSection[],
  anchor: VerseAddress,
): PericopeSuggestion[] {
  return sections
    .filter((section) => (
      compareAddresses(section.start, anchor) < 0
      && compareAddresses(section.end, anchor) >= 0
    ))
    .sort((a, b) => b.translations - a.translations || compareAddresses(a.end, b.end))
    .map((section) => toSuggestion(section, anchor, true))
}

/** Case 3 — the nearest boundary after `anchor`, with its alternatives. */
function fallForward(
  sections: readonly PericopeSection[],
  anchor: VerseAddress,
): PericopeSuggestion[] {
  const next = sections.find((section) => compareAddresses(section.start, anchor) > 0)
  if (!next) return []
  return sections
    .filter((section) => compareAddresses(section.start, next.start) === 0)
    .map((section) => toSuggestion(section, section.start, false))
}
