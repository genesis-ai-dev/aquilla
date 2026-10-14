// Supersession — "does this question still need an answer?" (seam design §4.3).
//
// PURE by design: no database, no HTTP, no model. Every branch here is a query
// the caller has already answered, so the whole thing unit-tests with plain
// values. Per CLAUDE.md Rule 5, code answers what code can answer; the ONLY
// judgment-shaped case (a free-text ambiguity someone resolved in the work
// without seeing the card) is deliberately NOT handled here — it returns false
// and is left for a gated model call that is out of scope for this slice.
//
// AQU-1691: a question that names a `factKey` asks for one project fact. It is
// settled when the project has decided that key by any route (the card, the
// Settings page, an agent), and it is stale when a NEWER open question asks
// for the same key — the newer one carries the current wording and options.
// ./fact-questions.ts runs this branch when it raises a fact question.

import { MIN_EXAMPLES, MIN_BRIEF_FIELDS, type ReadinessLevel } from "./readiness"
import type { DecisionReadinessItem } from "../../../../db/shared/contextual-decisions"

export interface SupersedableDecision {
  /** Needed by the fact branch to tell an older question from the newest. */
  id?: string
  readinessItem: DecisionReadinessItem | null
  conceptId: string | null
  factKey?: string | null
}

/** What the fact branch reads. */
export interface FactSupersessionSnapshot {
  /** Fact keys the project has already decided (db/shared/project-facts.ts decidedFactKeys). */
  decidedFactKeys: ReadonlySet<string>
  /** For each fact key, the id of its NEWEST open question. */
  newestOpenFactQuestion: ReadonlyMap<string, string>
}

export interface SupersessionSnapshot extends FactSupersessionSnapshot {
  /** Concept ids with a `preferred` or `admitted` rendering. */
  conceptsWithApprovedRenderings: ReadonlySet<string>
  validatedExamples: number
  briefFieldsAnswered: number
  readinessLevels: Record<Exclude<DecisionReadinessItem, "bible-fact">, ReadinessLevel>
}

/** The fact branch on its own: decided keys close, and a newer question closes an older one. */
export function isFactQuestionSuperseded(
  decision: SupersedableDecision,
  snap: FactSupersessionSnapshot,
): boolean {
  if (!decision.factKey) return false
  if (snap.decidedFactKeys.has(decision.factKey)) return true
  const newest = snap.newestOpenFactQuestion.get(decision.factKey)
  return newest !== undefined && decision.id !== undefined && newest !== decision.id
}

/** True when the gap that caused this decision has been filled by other means,
 *  so the run may proceed with nobody touching the card. */
export function isSuperseded(
  decision: SupersedableDecision,
  snap: SupersessionSnapshot,
): boolean {
  if (decision.factKey) return isFactQuestionSuperseded(decision, snap)
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
      // Free text, or a `bible-fact` question that names no key. Closing this
      // is a judgment call, not a query.
      return false
  }
}
