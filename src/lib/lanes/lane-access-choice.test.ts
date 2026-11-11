import { describe, expect, it } from "vitest"
import { ROLE } from "@/lib/frontier/roles"
import { NO_LANE_SCOPE } from "./no-lane-access"
import {
  chosenLaneLabels,
  grantsNoLanes,
  initialLaneChoice,
  laneChoiceReady,
  needsLaneChoice,
  toMemberLaneAccess,
} from "./lane-access-choice"

describe("lane access choice", () => {
  it("asks a project lead, and not a maintainer, when the project has a target lane", () => {
    expect(needsLaneChoice(ROLE.CONTRIBUTOR, 2)).toBe(true)
    expect(needsLaneChoice(ROLE.PROJECT_LEAD, 2)).toBe(true)
    expect(needsLaneChoice(ROLE.MAINTAINER, 2)).toBe(false)
    expect(needsLaneChoice(ROLE.CONTRIBUTOR, 0)).toBe(false)
  })

  it("is ready for every current lane, for named lanes, and for no lanes", () => {
    expect(laneChoiceReady(null, ROLE.CONTRIBUTOR, 2)).toBe(false)
    expect(laneChoiceReady({ kind: "all" }, ROLE.CONTRIBUTOR, 2)).toBe(true)
    // AQU-2358: an empty selection is an answer, so it no longer blocks.
    expect(laneChoiceReady({ kind: "lanes", laneIds: [] }, ROLE.CONTRIBUTOR, 2)).toBe(true)
    expect(laneChoiceReady({ kind: "lanes", laneIds: ["ln-es"] }, ROLE.CONTRIBUTOR, 2)).toBe(true)
    expect(laneChoiceReady(null, ROLE.MAINTAINER, 2)).toBe(true)
  })

  it("maps the choice onto the request fields", () => {
    expect(toMemberLaneAccess({ kind: "all" })).toEqual({ allCurrentLanes: true })
    expect(toMemberLaneAccess({ kind: "lanes", laneIds: ["ln-es"] })).toEqual({
      scopeLanes: ["ln-es"],
    })
  })

  // ── AQU-2358 ──
  it("sends the reserved value for an empty selection, never an empty list", () => {
    // An empty `scopeLanes` is indistinguishable from omitting the field, and
    // omitting it is what the server reads as "every current lane".
    expect(toMemberLaneAccess({ kind: "lanes", laneIds: [] })).toEqual({
      scopeLanes: [NO_LANE_SCOPE],
    })
  })

  it("flags an empty selection for confirmation, and nothing else", () => {
    expect(grantsNoLanes({ kind: "lanes", laneIds: [] }, ROLE.CONTRIBUTOR, 2)).toBe(true)
    expect(grantsNoLanes({ kind: "lanes", laneIds: ["ln-es"] }, ROLE.CONTRIBUTOR, 2)).toBe(false)
    expect(grantsNoLanes({ kind: "all" }, ROLE.CONTRIBUTOR, 2)).toBe(false)
    // Nothing chosen yet is "not ready", not "no lanes".
    expect(grantsNoLanes(null, ROLE.CONTRIBUTOR, 2)).toBe(false)
    // A maintainer is not lane-scoped, and a project with no lane has nothing
    // to warn about.
    expect(grantsNoLanes({ kind: "lanes", laneIds: [] }, ROLE.MAINTAINER, 2)).toBe(false)
    expect(grantsNoLanes({ kind: "lanes", laneIds: [] }, ROLE.CONTRIBUTOR, 0)).toBe(false)
  })

  it("pre-checks the only lane of a one-lane project, and guesses nothing else", () => {
    expect(initialLaneChoice([{ id: "ln-es" }], ROLE.CONTRIBUTOR)).toEqual({
      kind: "lanes",
      laneIds: ["ln-es"],
    })
    expect(initialLaneChoice([{ id: "ln-es" }, { id: "ln-fr" }], ROLE.CONTRIBUTOR)).toBeNull()
    expect(initialLaneChoice([], ROLE.CONTRIBUTOR)).toBeNull()
    expect(initialLaneChoice([{ id: "ln-es" }], ROLE.MAINTAINER)).toBeNull()
  })

  it("describes an empty selection as no lanes, not as every lane", () => {
    const lanes = [{ id: "ln-es", label: "Spanish" }, { id: "ln-fr", label: "French" }]
    expect(chosenLaneLabels(lanes, ROLE.CONTRIBUTOR, { kind: "lanes", laneIds: [] })).toBe("none")
    expect(chosenLaneLabels(lanes, ROLE.CONTRIBUTOR, { kind: "lanes", laneIds: ["ln-es"] })).toEqual([
      "Spanish",
    ])
    expect(chosenLaneLabels(lanes, ROLE.CONTRIBUTOR, { kind: "all" })).toBe("all")
    expect(chosenLaneLabels(lanes, ROLE.CONTRIBUTOR, null)).toBe("unknown")
  })
})
