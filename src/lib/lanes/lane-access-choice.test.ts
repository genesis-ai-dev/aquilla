import { describe, expect, it } from "vitest"
import { ROLE } from "@/lib/frontier/roles"
import { laneChoiceReady, needsLaneChoice, toMemberLaneAccess } from "./lane-access-choice"

describe("lane access choice", () => {
  it("asks only a below-lead role when the project has a target lane", () => {
    expect(needsLaneChoice(ROLE.CONTRIBUTOR, 2)).toBe(true)
    expect(needsLaneChoice(ROLE.PROJECT_LEAD, 2)).toBe(false)
    expect(needsLaneChoice(ROLE.CONTRIBUTOR, 0)).toBe(false)
  })

  it("is ready for every current lane, or for at least one named lane", () => {
    expect(laneChoiceReady(null, ROLE.CONTRIBUTOR, 2)).toBe(false)
    expect(laneChoiceReady({ kind: "all" }, ROLE.CONTRIBUTOR, 2)).toBe(true)
    expect(laneChoiceReady({ kind: "lanes", laneIds: [] }, ROLE.CONTRIBUTOR, 2)).toBe(false)
    expect(laneChoiceReady({ kind: "lanes", laneIds: ["ln-es"] }, ROLE.CONTRIBUTOR, 2)).toBe(true)
    expect(laneChoiceReady(null, ROLE.MAINTAINER, 2)).toBe(true)
  })

  it("maps the choice onto the request fields", () => {
    expect(toMemberLaneAccess({ kind: "all" })).toEqual({ allCurrentLanes: true })
    expect(toMemberLaneAccess({ kind: "lanes", laneIds: ["ln-es"] })).toEqual({
      scopeLanes: ["ln-es"],
    })
  })
})
