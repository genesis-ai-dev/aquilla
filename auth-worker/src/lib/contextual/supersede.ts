// Supersession — "does this question still need an answer?" (seam design §4.3).
//
// PURE by design: no database, no HTTP, no model. Every branch here is a query
// the caller has already answered, so the whole thing unit-tests with plain
// values. Per CLAUDE.md Rule 5, code answers what code can answer; the ONLY
// judgment-shaped case (a free-text ambiguity someone resolved in the work
// without seeing the card) is deliberately NOT handled here — it returns false
// and is left for a gated model call that is out of scope for this slice.

import { MIN_EXAMPLES, MIN_BRIEF_FIELDS, type ReadinessLevel } from "./readiness"
import type { DecisionReadinessItem } from "../../../../db/shared/contextual-decisions"

export interface SupersedableDecision {
  readinessItem: DecisionReadinessItem | null
  conceptId: string | null
}

export interface SupersessionSnapshot {
  /** Concept ids with a `preferred` or `admitted` rendering. */
  conceptsWithApprovedRenderings: ReadonlySet<string>
  validatedExamples: number
  briefFieldsAnswered: number
  readinessLevels: Record<DecisionReadinessItem, ReadinessLevel>
}

/** True when the gap that caused this decision has been filled by other means,
 *  so the run may proceed with nobody touching the card. */
export function isSuperseded(
  decision: SupersedableDecision,
  snap: SupersessionSnapshot,
): boolean {
  switch (decision.readinessItem) {
    case "terminology":
      // A terminology decision that names no concept cannot be checked
      // mechanically — treat it as still open rather than guessing.
      return decision.conceptId
        ? snap.conceptsWithApprovedRenderings.has(decision.conceptId)
        : false
    case "examples":
      return snap.validatedExamples >= MIN_EXAMPLES
    case "brief":
      return snap.briefFieldsAnswered >= MIN_BRIEF_FIELDS
    case "rules":
    case "languages":
      return snap.readinessLevels[decision.readinessItem] !== "missing"
    default:
      // Free text. Closing this is a judgment call, not a query.
      return false
  }
}
