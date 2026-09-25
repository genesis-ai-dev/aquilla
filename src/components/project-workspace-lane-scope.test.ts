import { describe, it, expect } from "vitest"
import { decideScopedLandingLane, resolveScopedLandingLane } from "./project-workspace-lane-scope"
import type { MemberScope } from "@/lib/sync/member-scopes"

// AQU-1029: a lane-scoped member must open a project on the lane they are
// assigned to, not on the Project default lane.
describe("resolveScopedLandingLane", () => {
  const available = ["", "es", "fr"]
  const lane = (value: string): MemberScope => ({ kind: "lane", value })
  const file = (value: string): MemberScope => ({ kind: "file", value })

  it("returns the member's own lane so opening the project lands there", () => {
    expect(resolveScopedLandingLane([lane("es")], available)).toBe("es")
    expect(resolveScopedLandingLane([lane("fr")], available)).toBe("fr")
  })

  it("has no opinion for an unscoped member (also covers scopes not loaded yet)", () => {
    expect(resolveScopedLandingLane([], available)).toBeNull()
    expect(resolveScopedLandingLane(null, available)).toBeNull()
    expect(resolveScopedLandingLane(undefined, available)).toBeNull()
  })

  it("has no opinion when the member only carries file scopes", () => {
    expect(resolveScopedLandingLane([file("file/1"), file("file/2")], available)).toBeNull()
  })

  it("leaves a member scoped to the default lane where they already land", () => {
    expect(resolveScopedLandingLane([lane("")], available)).toBeNull()
    // Default lane in scope alongside another lane → the default is a lane
    // they may write, so landing there is correct.
    expect(resolveScopedLandingLane([lane("es"), lane("")], available)).toBeNull()
  })

  it("ignores a lane scope the project does not offer", () => {
    expect(resolveScopedLandingLane([lane("de")], available)).toBeNull()
    expect(resolveScopedLandingLane([lane("es")], [""])).toBeNull()
  })

  it("picks the first offered lane when several are in scope", () => {
    expect(resolveScopedLandingLane([lane("de"), lane("fr"), lane("es")], available)).toBe("fr")
  })

  it("matches a scope written in another form of the same language tag", () => {
    expect(resolveScopedLandingLane([lane("es-ES")], available)).toBe("es")
    expect(resolveScopedLandingLane([lane("spa")], available)).toBe("es")
  })

  it("returns the offered lane's own tag, never the scope's raw value", () => {
    expect(resolveScopedLandingLane([lane("fra")], ["", "fr"])).toBe("fr")
  })

  it("does not fight AQU-1240: a scope naming the primary target stays on default", () => {
    // Project primary target is Spanish, so `es` is filtered out of
    // availableLanes — the default lane already IS Spanish.
    expect(resolveScopedLandingLane([lane("es")], ["", "fr"])).toBe(null)
  })

  it("only considers lane scopes, never file scopes, when matching", () => {
    expect(resolveScopedLandingLane([file("es"), lane("fr")], available)).toBe("fr")
  })
})

// The precedence chain in front of the rule: the seed is the last voice in the
// room and must never fight a deep link, a stored choice, or itself.
describe("decideScopedLandingLane", () => {
  const available = ["", "es", "fr"]
  const lane = (value: string): MemberScope => ({ kind: "lane", value })
  const settled = {
    hasLaneParam: false,
    persistedLane: "",
    alreadySeeded: false,
    projectLoaded: true,
    scopes: [lane("fr")],
    availableLanes: available,
  }

  it("THE BUG: a lane-scoped member opening the project cold is seeded onto their lane", () => {
    expect(decideScopedLandingLane(settled)).toEqual({ action: "seed", lane: "fr" })
  })

  it("stands down for a ?lane= deep link, even before anything has loaded", () => {
    expect(
      decideScopedLandingLane({ ...settled, hasLaneParam: true, projectLoaded: false, scopes: [] }),
    ).toEqual({ action: "stand-down" })
  })

  it("stands down when the member already chose a lane on this project", () => {
    expect(decideScopedLandingLane({ ...settled, persistedLane: "es" })).toEqual({
      action: "stand-down",
    })
  })

  it("stands down once the seed has run — switching back to default must stick", () => {
    // The regression this guards: Project default persists as an ABSENT key,
    // so without the seeded marker this reads identically to a cold open and
    // the member gets dragged back onto their lane on every reload.
    expect(
      decideScopedLandingLane({ ...settled, persistedLane: "", alreadySeeded: true }),
    ).toEqual({ action: "stand-down" })
  })

  it("waits for the lane registry before deciding", () => {
    expect(decideScopedLandingLane({ ...settled, projectLoaded: false })).toEqual({
      action: "wait",
    })
  })

  it("waits while the scopes fetch is in flight (indistinguishable from unscoped)", () => {
    expect(decideScopedLandingLane({ ...settled, scopes: [] })).toEqual({ action: "wait" })
    expect(decideScopedLandingLane({ ...settled, scopes: null })).toEqual({ action: "wait" })
  })

  it("THE SPA-NAV REGRESSION: never burns the one-shot against a lane registry that has not arrived", () => {
    // `targetLanes` arrives on a SEPARATE settings fetch overlaid onto the
    // project record, so on client-side navigation `project` is truthy while
    // `availableLanes` is still just the default lane. Spending the one-shot
    // here pinned a scoped member to Project default permanently — QA caught
    // it walking "Open project" from the overview.
    const registryNotYetIn = { ...settled, availableLanes: [""] }
    expect(decideScopedLandingLane(registryNotYetIn)).toEqual({ action: "wait" })
    // …and when the registry lands on a later render, it seeds as intended.
    expect(decideScopedLandingLane({ ...registryNotYetIn, availableLanes: ["", "fr"] })).toEqual({
      action: "seed",
      lane: "fr",
    })
  })

  it("waits rather than settling when the scopes name no lane this project offers", () => {
    // Indistinguishable from "registry not in yet", and waiting costs nothing:
    // it writes no marker and changes no lane.
    expect(decideScopedLandingLane({ ...settled, scopes: [lane("de")] })).toEqual({
      action: "wait",
    })
  })

  it("only ever seeds a real lane, so the caller never has a null to handle", () => {
    const decision = decideScopedLandingLane(settled)
    expect(decision.action).toBe("seed")
    if (decision.action === "seed") expect(decision.lane).toBeTruthy()
  })
})
