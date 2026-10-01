// AQU-1493: the one rule every progress figure follows — a whole-number
// percentage that never reads 100 while any work is left.
//
// Plain rounding puts anything within half a percent of the whole at "100%":
// on a 1,200-cell book that is six untranslated cells. The project board, the
// sidebar and the org tables each rounded on their own, so a book could read
// "100%" in one place and "6 cells to translate" in the next. 100 is reserved
// for part === whole, and everything short of it stops at 99.
//
// For PROGRESS only — translated, validated, recorded, a person's share of an
// assignment. Not for an import or download in flight, a confidence score or a
// bill, where a rounded 100 means what it says.

/** `part` of `whole` as 0–100; 100 only when nothing is outstanding. */
export function progressPercent(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part)) return 0
  if (part >= whole) return 100
  return Math.max(0, Math.min(99, Math.round((part / whole) * 100)))
}

/**
 * The same rule for a call site that holds only a fraction (0–1). Prefer
 * `progressPercent` with the counts wherever they are to hand.
 *
 * A fraction of exactly 1 is complete; a hair under it is not. That holds for
 * a ratio of two counts and for an average of such ratios too: the average of
 * n exact 1s is exactly 1, and any project short of complete pulls it below —
 * so an org's "average validated" reads 100% only when every project is.
 */
export function progressPercentOfFraction(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0
  if (fraction >= 1) return 100
  return Math.min(99, Math.round(fraction * 100))
}
