/**
 * By-concept terminology violations inbox.
 *
 * Groups RuleInfractions produced by the shared rule-engine (derive-on-read)
 * into one row per concept. Only terminology rules are considered — i.e. rules
 * whose id follows the STABLE compiled-id scheme from
 * `@/lib/terminology/compile.ts`:
 *
 *   term:{conceptId}:approved                 → a missing-approved-rendering violation
 *   term:{conceptId}:forbidden:{rendering...} → a forbidden-rendering-present violation
 *
 * `conceptId` is a UUID (no colons), so it is always the second `:`-delimited
 * segment. The forbidden rendering tail may itself contain colons (the rule id
 * does not escape `:`), so we never assume a fixed segment count beyond the
 * conceptId — we only read the *kind* from segment[2].
 *
 * This module is pure: it does NOT evaluate rules. Feed it the infractions the
 * existing engine already computed (e.g. flattened from
 * `checkRules(...)` / the editor's infraction map). No parallel engine.
 */

import type { RuleInfraction } from "@/lib/parsers/types"
import type { Concept } from "./types"

export type TerminologyViolationKind = "missing-approved" | "forbidden-present"

export interface ConceptViolationGroup {
  conceptId: string
  /** Source headword for the concept, when it resolves against the supplied
   *  concepts; falls back to the conceptId when unknown (e.g. a stale rule). */
  sourceTerm: string
  /** Total infractions across both kinds for this concept. */
  count: number
  /** Count of "term present in source but no approved rendering in target". */
  missingApprovedCount: number
  /** Count of "a forbidden rendering appears in the target". */
  forbiddenPresentCount: number
  /** The offending infractions, in input order, each tagged with its kind. */
  infractions: Array<RuleInfraction & { kind: TerminologyViolationKind }>
}

const TERM_PREFIX = "term:"

/**
 * Parse a compiled terminology rule id into its conceptId + violation kind.
 * Returns null for any id that is not a terminology rule.
 */
export function parseTerminologyRuleId(
  ruleId: string,
): { conceptId: string; kind: TerminologyViolationKind } | null {
  if (!ruleId.startsWith(TERM_PREFIX)) return null
  // segments: ["term", conceptId, kindSegment, ...forbiddenTail]
  const segments = ruleId.split(":")
  if (segments.length < 3) return null
  const conceptId = segments[1]
  if (!conceptId) return null
  const kindSegment = segments[2]
  if (kindSegment === "approved") {
    return { conceptId, kind: "missing-approved" }
  }
  if (kindSegment === "forbidden") {
    return { conceptId, kind: "forbidden-present" }
  }
  return null
}

/**
 * Group terminology infractions by concept.
 *
 * @param infractions  Flat list of infractions from the shared rule-engine.
 * @param concepts     Optional concepts used to resolve each group's sourceTerm.
 * @returns One group per concept that has at least one terminology infraction,
 *          sorted by descending total count (ties broken by sourceTerm).
 */
export function groupTerminologyInfractions(
  infractions: RuleInfraction[],
  concepts: Concept[] = [],
): ConceptViolationGroup[] {
  const sourceTermById = new Map<string, string>()
  for (const c of concepts) sourceTermById.set(c.id, c.sourceTerm)

  const groups = new Map<string, ConceptViolationGroup>()

  for (const inf of infractions) {
    const parsed = parseTerminologyRuleId(inf.ruleId)
    if (!parsed) continue
    const { conceptId, kind } = parsed

    let group = groups.get(conceptId)
    if (!group) {
      group = {
        conceptId,
        sourceTerm: sourceTermById.get(conceptId) ?? conceptId,
        count: 0,
        missingApprovedCount: 0,
        forbiddenPresentCount: 0,
        infractions: [],
      }
      groups.set(conceptId, group)
    }

    group.count += 1
    if (kind === "missing-approved") group.missingApprovedCount += 1
    else group.forbiddenPresentCount += 1
    group.infractions.push({ ...inf, kind })
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.sourceTerm.localeCompare(b.sourceTerm),
  )
}
