import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useRules } from "./useRules"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"
import { mapSubscribedConceptLanes } from "@/lib/terminology/rendering-lane"

/**
 * Verifies the concept-merge contract added for org termbase subscriptions:
 *   1. Subscribed (org-managed) concepts are folded into the same compiled
 *      terminology-rule set as local terminology — so they enforce
 *      DETERMINISTICALLY via the identical derive-on-read path. (Rule 9: the
 *      test encodes WHY — subscribed managed terms must behave like local
 *      managed terms, not a separate probabilistic path.)
 *   2. Subscribed concepts take precedence: they are unioned AHEAD of local
 *      terminology, in the subscription-priority order the caller supplies.
 */

function concept(id: string, sourceTerm: string): Concept {
  return {
    id,
    sourceTerm,
    renderings: [{ rendering: `r-${id}`, status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

function project(terminology: Concept[]): ProjectRecord {
  return {
    id: "p1",
    name: "P",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    members: [],
    terminology,
  }
}

const noop = () => {}

function termRuleIds(rules: { id: string }[]): string[] {
  return rules.filter((r) => r.id.startsWith("term:")).map((r) => r.id)
}

describe("useRules — subscribed concept merge", () => {
  it("compiles subscribed concepts into the terminology rule set (same deterministic path)", () => {
    const subscribed = [concept("sub1", "grace")]
    const { result } = renderHook(() =>
      useRules(project([]), noop, undefined, undefined, subscribed),
    )
    expect(termRuleIds(result.current.rules)).toContain("term:sub1:approved")
  })

  it("orders subscribed concepts BEFORE local terminology", () => {
    const subscribed = [concept("sub1", "grace"), concept("sub2", "mercy")]
    const local = [concept("loc1", "peace")]
    const { result } = renderHook(() =>
      // AQU-1006 follow-up: local concepts now arrive as the `localConcepts`
      // parameter (from useConcepts / the projection), not on the project
      // record. The ordering contract under test is unchanged.
      useRules(project(local), noop, undefined, undefined, subscribed, undefined, local),
    )
    const ids = termRuleIds(result.current.rules)
    expect(ids).toEqual([
      "term:sub1:approved",
      "term:sub2:approved",
      "term:loc1:approved",
    ])
  })

  it("preserves the caller's subscription-priority order among subscribed concepts", () => {
    // Caller passes them already priority-ordered; the hook must not reorder.
    const subscribed = [concept("hi", "alpha"), concept("lo", "beta")]
    const { result } = renderHook(() =>
      useRules(project([]), noop, undefined, undefined, subscribed),
    )
    expect(termRuleIds(result.current.rules)).toEqual([
      "term:hi:approved",
      "term:lo:approved",
    ])
  })

  it("behaves identically to no-subscriptions when subscribedConcepts is omitted", () => {
    const local = [concept("loc1", "peace")]
    const { result } = renderHook(() => useRules(project(local), noop, undefined, undefined, undefined, undefined, local))
    expect(termRuleIds(result.current.rules)).toEqual(["term:loc1:approved"])
  })
})

// AQU-1777: a subscribed rendering carries the TERMBASE's lane id. Route #8
// maps it onto this project's lane of the same language before the hook sees
// it, and from there the lane filter treats it exactly like a local one.
describe("useRules — subscribed renderings follow the lane (AQU-1777)", () => {
  const laneRow = (id: string, legacyTag: string, language: string) => ({
    id,
    role: "target" as const,
    language,
    name: null,
    langCode: null,
    legacyTag,
    position: 1,
    archivedAt: null,
  })
  // The subscriber: a Spanish `''` lane and a French lane.
  const lanes = [laneRow("50000e5a", "", "Spanish"), laneRow("50000f7a", "fr", "French")]
  // The termbase: one `''` lane, Spanish spelled as a code.
  const termbaseLanes = [laneRow("t0000e5a", "", "es")]

  it("compiles a subscribed rendering in the matching lane and in no other", () => {
    const subscribed = mapSubscribedConceptLanes([concept("sub1", "grace")], termbaseLanes, lanes)
    const subscriber = { ...project([]), lanes }
    const spanish = renderHook(() => useRules(subscriber, noop, undefined, undefined, subscribed, ""))
    const french = renderHook(() => useRules(subscriber, noop, undefined, undefined, subscribed, "fr"))
    expect(termRuleIds(spanish.result.current.rules)).toEqual(["term:sub1:approved"])
    expect(termRuleIds(french.result.current.rules)).toEqual([])
  })

  it("keeps the project's own renderings on today's rule beside them", () => {
    const subscribed = mapSubscribedConceptLanes([concept("sub1", "grace")], termbaseLanes, lanes)
    const local = [concept("loc1", "peace")] // unstamped: this project's `''` lane
    const subscriber = { ...project(local), lanes }
    const spanish = renderHook(() => useRules(subscriber, noop, undefined, undefined, subscribed, "", local))
    const french = renderHook(() => useRules(subscriber, noop, undefined, undefined, subscribed, "fr", local))
    expect(termRuleIds(spanish.result.current.rules)).toEqual(["term:sub1:approved", "term:loc1:approved"])
    expect(termRuleIds(french.result.current.rules)).toEqual([])
  })
})
