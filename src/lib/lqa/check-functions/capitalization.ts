import type { InfractionSpan } from "@/lib/parsers/types"
import { findLowercaseStarts } from "@/lib/qa/capitalization"

export const MESSAGE = "Lowercase letter where a capital is expected"

/**
 * AQU-1734: a lowercase letter opening a sentence (after sentence-final
 * punctuation) or opening a paragraph/heading (after its marker). Pure per
 * cell — see `src/lib/qa/capitalization.ts` for why the mixed-capitalization
 * half of this check is corpus-scoped and deliberately not a built-in.
 *
 * Suppressed when the SOURCE does the same thing at least as often, the
 * precedent `repeated-word` sets: a software-localization file or a poetry
 * source that deliberately runs lowercase after a full stop is a style, not a
 * translator's slip, and this check is on by default in every project.
 */
export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const hits = findLowercaseStarts(target)
  if (hits.length === 0) return null
  if (findLowercaseStarts(source).length >= hits.length) return null
  return hits.map((h) => ({
    side: "target" as const,
    start: h.start,
    end: h.end,
    matchedText: h.matchedText,
  }))
}
