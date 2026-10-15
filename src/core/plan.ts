/**
 * Transformation planning: for one document and one target locale, decide what
 * happens to every unit. Pure — the pipeline executes the plan.
 *
 * The planner encodes the product's authority rules:
 *  - agent output is reused only for the same source hash *and* context revision;
 *  - human/approved translations are reused for the same source hash regardless
 *    of later decisions or newer model output;
 *  - when the source changes under a human translation, the human text is never
 *    silently discarded: by policy it is either held (published as-is and
 *    flagged) or revised by the agent *with the human text as the base* and
 *    flagged for review;
 *  - ambiguous identities are never resolved by guessing.
 */
import { contentHashOf, effectiveTranslation, latestHuman, latestProposal, unitKey } from "./ledger.ts"
import type { Effective, HumanVersion, LedgerState, Proposal, UnitSnapshot } from "./ledger.ts"
import { unitContext } from "./context.ts"
import type { UnitContext } from "./context.ts"
import type { ContentUnit, IdentityMatch } from "./types.ts"

export type SourceChangePolicy = "revise" | "hold"

export interface PlanPolicy {
  /** What to do when the source changes under a human translation. */
  readonly onSourceChangeUnderHuman: SourceChangePolicy
}

export interface PriorTranslation {
  readonly logicalId: string
  readonly source: string
  readonly target: string
  readonly authority: "agent" | "human" | "approved"
}

export type PlanReason =
  | "reuse"
  | "new"
  | "source-changed"
  | "context-changed"
  | "split"
  | "merged"
  | "ambiguous"
  | "human-source-changed"

export interface UnitPlan {
  readonly unit: ContentUnit
  readonly match: IdentityMatch
  readonly context: UnitContext
  readonly action: "keep" | "translate" | "hold"
  readonly reason: PlanReason
  /** Present for keep/hold. */
  readonly effective?: Effective
  /** Prior translations that inform the new one (previous version of this unit, or predecessors of a split/merge). */
  readonly prior: PriorTranslation[]
  /** Set when the translation would replace human work — the result must be reviewed. */
  readonly revisesHuman?: string
  readonly needsReview: boolean
}

export interface PlanInput {
  readonly docId: string
  readonly locale: string
  readonly units: readonly ContentUnit[]
  readonly matches: readonly IdentityMatch[]
  /** Units of the previous observation (for prior source text). */
  readonly previousUnits: readonly UnitSnapshot[]
  readonly state: LedgerState
  readonly policy: PlanPolicy
}

export const planLocale = (input: PlanInput): UnitPlan[] => {
  const { docId, locale, state } = input
  const prevById = new Map(input.previousUnits.map((u) => [u.logicalId, u]))

  const priorFor = (logicalId: string): PriorTranslation | undefined => {
    const u = state.units.get(unitKey(docId, logicalId, locale))
    const prev = prevById.get(logicalId)
    if (!u || !prev) return undefined
    const human = latestHuman(u)
    if (human && human.sourceHash === prev.contentHash) {
      return { logicalId, source: prev.tagged, target: human.content, authority: human.approved ? "approved" : "human" }
    }
    const p = latestProposal(u, prev.contentHash)
    return p ? { logicalId, source: prev.tagged, target: p.content, authority: "agent" } : undefined
  }

  return input.units.map((unit, i): UnitPlan => {
    const match = input.matches[i]!
    const context = unitContext(state, locale, unit.plain)
    const base = { unit, match, context }
    const effective = effectiveTranslation(state, docId, unit.logicalId, locale, unit.contentHash, context.contextRevision)

    if (match.status === "ambiguous") {
      // Never guess: translate fresh, carry candidates as context, and require review.
      const prior = match.predecessors.flatMap((id) => priorFor(id) ?? [])
      if (effective) return { ...base, action: "keep", reason: "reuse", effective, prior, needsReview: effective.authority === "agent" }
      return { ...base, action: "translate", reason: "ambiguous", prior, needsReview: true }
    }

    if (match.status === "split" || match.status === "merged") {
      if (effective) return { ...base, action: "keep", reason: "reuse", effective, prior: [], needsReview: false }
      const prior = match.predecessors.flatMap((id) => priorFor(id) ?? [])
      const humanPrior = prior.find((p) => p.authority !== "agent")
      return {
        ...base,
        action: "translate",
        reason: match.status,
        prior,
        needsReview: humanPrior !== undefined,
        ...(humanPrior ? { revisesHuman: humanPrior.logicalId } : {}),
      }
    }

    if (effective) return { ...base, action: "keep", reason: "reuse", effective, prior: [], needsReview: false }

    const u = state.units.get(unitKey(docId, unit.logicalId, locale))
    const human: HumanVersion | undefined = u ? latestHuman(u) : undefined
    const prior = priorFor(unit.logicalId)
    if (human && human.sourceHash !== unit.contentHash) {
      const humanPrior: PriorTranslation = {
        logicalId: unit.logicalId,
        source: prevSourceFor(state, docId, unit.logicalId, human.sourceHash) ?? prior?.source ?? "",
        target: human.content,
        authority: human.approved ? "approved" : "human",
      }
      if (input.policy.onSourceChangeUnderHuman === "hold") {
        return {
          ...base,
          action: "hold",
          reason: "human-source-changed",
          effective: { content: human.content, contentHash: contentHashOf(human.content), authority: humanPrior.authority, origin: human.approved ? "approved" : "human", opId: human.opId },
          prior: [humanPrior],
          needsReview: true,
        }
      }
      return { ...base, action: "translate", reason: "human-source-changed", prior: [humanPrior], revisesHuman: human.opId, needsReview: true }
    }
    const sameSource: Proposal | undefined = u ? latestProposal(u, unit.contentHash) : undefined
    if (sameSource) return { ...base, action: "translate", reason: "context-changed", prior: prior ? [prior] : [], needsReview: false }
    if (prior || match.status === "modified" || match.status === "moved") {
      return { ...base, action: "translate", reason: prior ? "source-changed" : "new", prior: prior ? [prior] : [], needsReview: false }
    }
    return { ...base, action: "translate", reason: "new", prior: [], needsReview: false }
  })
}

/** Find the source text a unit had when it carried `sourceHash` (scans observations newest-first). */
const prevSourceFor = (state: LedgerState, docId: string, logicalId: string, sourceHash: string): string | undefined => {
  const doc = state.docs.get(docId)
  const u = doc?.units.find((x) => x.logicalId === logicalId && x.contentHash === sourceHash)
  return u?.tagged
}
