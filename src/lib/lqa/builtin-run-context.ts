import type { PunctuationConventions } from "../../../db/shared/punctuation-conventions"

/**
 * AQU-1906: per-LANE inputs a built-in check function may read, resolved once
 * where the rule set is built (`resolveBuiltinRules`) and carried on the
 * rule's `check` descriptor — not per cell, because none of it varies by cell.
 *
 * Its own module so a check function can import the type without importing the
 * registry that imports every check function.
 */
export interface BuiltinCheckRunContext {
  /**
   * The target lane's punctuation conventions. Absent or null keeps the
   * universal, source-relative sets the punctuation checks used before
   * AQU-1906 — which is what a lane with no recorded language gets.
   */
  punctuation?: PunctuationConventions | null
}
