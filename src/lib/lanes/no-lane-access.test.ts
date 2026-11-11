import { describe, expect, it } from "vitest"
import { NO_LANE_SCOPE, grantsNoLaneScopes, isNoLaneScope, laneScopesForChoice } from "./no-lane-access"

describe("no-lane access sentinel (AQU-2358)", () => {
  it("is not a lane id or a language tag anyone could mint", () => {
    expect(NO_LANE_SCOPE).toBe("__no_lanes__")
    expect(isNoLaneScope(NO_LANE_SCOPE)).toBe(true)
    expect(isNoLaneScope("es")).toBe(false)
    expect(isNoLaneScope("")).toBe(false)
    expect(isNoLaneScope("ln-es")).toBe(false)
  })

  it("reads 'no lanes' off the sentinel and never off an empty list", () => {
    expect(grantsNoLaneScopes([NO_LANE_SCOPE])).toBe(true)
    expect(grantsNoLaneScopes(["ln-es", NO_LANE_SCOPE])).toBe(true)
    // An empty list is the legacy "every current lane" shape: reading it as
    // "none" would strip lanes from every member minted before this ticket.
    expect(grantsNoLaneScopes([])).toBe(false)
    expect(grantsNoLaneScopes(["ln-es"])).toBe(false)
  })

  it("stores an empty choice as the sentinel, so a later re-plan stays empty", () => {
    expect(laneScopesForChoice([])).toEqual([NO_LANE_SCOPE])
    expect(laneScopesForChoice(["ln-es"])).toEqual(["ln-es"])
  })
})
