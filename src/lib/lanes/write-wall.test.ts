import { describe, expect, it } from "vitest"
import { decideLaneWrite, effectiveRoleInLane } from "./write-wall"
import type { LaneIdentity } from "./read-wall"

const lanes: LaneIdentity[] = [
  { id: "lane-es", name: "Spanish", legacyTag: "es" },
  { id: "lane-fr", name: "French", legacyTag: "fr" },
  { id: "lane-yt", name: "Yoruba Team", legacyTag: "yo" },
  { id: "lane-yv", name: "Yoruba Village", legacyTag: "yo-village" },
  { id: "lane-def", name: "English", legacyTag: "" },
]

const base = {
  enabled: true,
  role: 400,
  laneTag: "es",
  lanes,
  requiredRole: 400,
}

describe("decideLaneWrite", () => {
  it("skips when the wall is off, the caller is a maintainer, or the token is platform", () => {
    expect(decideLaneWrite({ ...base, enabled: false, laneGrants: [] }).action).toBe("skip")
    expect(decideLaneWrite({ ...base, role: 600, laneGrants: [] }).action).toBe("skip")
    expect(decideLaneWrite({ ...base, src: "platform", role: 100, laneGrants: [] }).action).toBe("skip")
  })

  it("denies a below-maintainer write with no grant", () => {
    const decision = decideLaneWrite({ ...base, laneGrants: [] })
    expect(decision).toEqual({ action: "deny", reason: "no lane grant for 'es'" })
  })

  it("allows the granted lane and denies the sibling", () => {
    const grants = [{ lane: "lane-es", level: 400 }]
    expect(decideLaneWrite({ ...base, laneGrants: grants }).action).toBe("allow")
    expect(decideLaneWrite({ ...base, laneTag: "fr", laneGrants: grants }).action).toBe("deny")
  })

  it("matches a lane by its display name and refuses a language that names two lanes", () => {
    const grants = [{ lane: "lane-yt", level: 400 }]
    expect(decideLaneWrite({ ...base, laneTag: "Yoruba Team", laneGrants: grants }).action).toBe("allow")
    const ambiguous = decideLaneWrite({
      ...base,
      laneTag: "yo",
      lanes: [
        ...lanes,
        { id: "lane-yo-2", name: "Yoruba Other", legacyTag: "yo" },
      ],
      laneGrants: grants,
    })
    expect(ambiguous.action).toBe("deny")
  })

  it("lets a grant elevate a commenter to contributor inside that lane only", () => {
    const elevated = decideLaneWrite({
      ...base,
      role: 200,
      requiredRole: 400,
      laneGrants: [{ lane: "lane-es", level: 400 }],
    })
    expect(elevated).toEqual({ action: "allow", effectiveRole: 400 })
    expect(effectiveRoleInLane(200, null)).toBeNull()
    expect(effectiveRoleInLane(400, 100)).toBe(400)
  })

  it("ignores a grant below viewer", () => {
    const decision = decideLaneWrite({
      ...base,
      laneGrants: [{ lane: "lane-es", level: 50 }],
    })
    expect(decision.action).toBe("deny")
  })

  it("resolves the empty-string default lane", () => {
    const decision = decideLaneWrite({
      ...base,
      laneTag: "",
      laneGrants: [{ lane: "lane-def", level: 400 }],
    })
    expect(decision.action).toBe("allow")
  })
})
