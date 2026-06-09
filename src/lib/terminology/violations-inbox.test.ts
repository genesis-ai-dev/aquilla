import { describe, it, expect } from "vitest"
import {
  parseTerminologyRuleId,
  groupTerminologyInfractions,
} from "./violations-inbox"
import type { RuleInfraction } from "@/lib/parsers/types"
import type { Concept } from "./types"

function inf(ruleId: string, cellId = "cell-1"): RuleInfraction {
  return { ruleId, cellId, fileId: "file-1", message: "m", spans: [] }
}

describe("parseTerminologyRuleId", () => {
  it("parses an approved (missing-approved) rule id", () => {
    expect(parseTerminologyRuleId("term:abc-123:approved")).toEqual({
      conceptId: "abc-123",
      kind: "missing-approved",
    })
  })

  it("parses a forbidden rule id", () => {
    expect(parseTerminologyRuleId("term:abc-123:forbidden:bad")).toEqual({
      conceptId: "abc-123",
      kind: "forbidden-present",
    })
  })

  it("parses a forbidden rule id whose rendering tail contains extra colons", () => {
    // The compiled id does NOT escape ':' in the forbidden rendering, so the
    // tail can contain colons. conceptId is always segment[1] (a UUID).
    expect(
      parseTerminologyRuleId("term:abc-123:forbidden:a:b:c"),
    ).toEqual({ conceptId: "abc-123", kind: "forbidden-present" })
  })

  it("returns null for non-terminology rule ids", () => {
    expect(parseTerminologyRuleId("builtin:numbers")).toBeNull()
    expect(parseTerminologyRuleId("some-user-rule")).toBeNull()
  })

  it("returns null for malformed term ids and unknown kinds", () => {
    expect(parseTerminologyRuleId("term:abc-123")).toBeNull()
    expect(parseTerminologyRuleId("term:abc-123:bogus")).toBeNull()
    expect(parseTerminologyRuleId("term::approved")).toBeNull()
  })
})

describe("groupTerminologyInfractions", () => {
  const concepts: Concept[] = [
    {
      id: "c1",
      sourceTerm: "spirit",
      renderings: [],
      status: "active",
      createdAt: "now",
    },
    {
      id: "c2",
      sourceTerm: "grace",
      renderings: [],
      status: "active",
      createdAt: "now",
    },
  ]

  it("ignores non-terminology infractions", () => {
    const groups = groupTerminologyInfractions(
      [inf("builtin:numbers"), inf("user-rule-x")],
      concepts,
    )
    expect(groups).toEqual([])
  })

  it("groups one row per concept with correct total count", () => {
    const groups = groupTerminologyInfractions(
      [
        inf("term:c1:approved", "cellA"),
        inf("term:c1:forbidden:foo", "cellB"),
        inf("term:c2:approved", "cellC"),
      ],
      concepts,
    )
    expect(groups).toHaveLength(2)
    const byId = Object.fromEntries(groups.map((g) => [g.conceptId, g]))
    expect(byId.c1.count).toBe(2)
    expect(byId.c2.count).toBe(1)
  })

  it("splits the count into missing-approved vs forbidden-present", () => {
    const [g] = groupTerminologyInfractions(
      [
        inf("term:c1:approved"),
        inf("term:c1:approved"),
        inf("term:c1:forbidden:foo"),
      ],
      concepts,
    )
    expect(g.missingApprovedCount).toBe(2)
    expect(g.forbiddenPresentCount).toBe(1)
    expect(g.count).toBe(3)
    expect(g.infractions.map((i) => i.kind)).toEqual([
      "missing-approved",
      "missing-approved",
      "forbidden-present",
    ])
  })

  it("resolves sourceTerm from concepts, falling back to conceptId", () => {
    const groups = groupTerminologyInfractions(
      [inf("term:c1:approved"), inf("term:unknown:approved")],
      concepts,
    )
    const byId = Object.fromEntries(groups.map((g) => [g.conceptId, g]))
    expect(byId.c1.sourceTerm).toBe("spirit")
    expect(byId.unknown.sourceTerm).toBe("unknown")
  })

  it("sorts by descending count then sourceTerm", () => {
    const groups = groupTerminologyInfractions(
      [
        inf("term:c2:approved"),
        inf("term:c1:approved"),
        inf("term:c1:forbidden:x"),
      ],
      concepts,
    )
    // c1 has 2, c2 has 1 → c1 first
    expect(groups.map((g) => g.conceptId)).toEqual(["c1", "c2"])
  })

  it("attributes a forbidden id with colons in the rendering to the right concept", () => {
    const [g] = groupTerminologyInfractions(
      [inf("term:c1:forbidden:a:b:c")],
      concepts,
    )
    expect(g.conceptId).toBe("c1")
    expect(g.forbiddenPresentCount).toBe(1)
  })
})
