import { describe, expect, it } from "vitest"
import {
  DEFAULT_LANE_SELECT_VALUE,
  buildLaneItems,
  initialAssignmentLane,
  isDefaultLaneValue,
  laneIdForTag,
  laneTagForAssignment,
  selectValueForLane,
} from "./assignment-lane"

describe("assignment lane (AQU-729)", () => {
  it("treats empty, the select sentinel, and the word default as the default lane", () => {
    for (const value of ["", "  ", "default", "Default", "Default language", DEFAULT_LANE_SELECT_VALUE, null, undefined]) {
      expect(isDefaultLaneValue(value)).toBe(true)
      expect(laneTagForAssignment(value)).toBeUndefined()
      expect(selectValueForLane(value)).toBe(DEFAULT_LANE_SELECT_VALUE)
    }
  })

  it("keeps an explicit language tag and never rewrites it to the default lane", () => {
    expect(laneTagForAssignment("Swahili")).toBe("Swahili")
    expect(laneTagForAssignment(" es ")).toBe("es")
    expect(selectValueForLane("Swahili")).toBe("Swahili")
    expect(isDefaultLaneValue("World English")).toBe(false)
  })
})

describe("buildLaneItems (AQU-1601)", () => {
  const fallback = "Default language"

  it("names the only lane instead of returning nothing", () => {
    expect(buildLaneItems({ defaultLaneLabel: "French", defaultLaneFallback: fallback })).toEqual([
      { value: DEFAULT_LANE_SELECT_VALUE, label: "French" },
    ])
  })

  it("lists the default lane and each extra lane, and a row name wins over the tag", () => {
    expect(
      buildLaneItems({
        targetLanes: ["es", ""],
        laneLabels: { "": "French", es: "Spanish" },
        defaultLaneFallback: fallback,
      }),
    ).toEqual([
      { value: DEFAULT_LANE_SELECT_VALUE, label: "French" },
      { value: "es", label: "Spanish" },
    ])
  })

  it("keeps only the lanes a delegate grant names, including the default lane", () => {
    const items = buildLaneItems({
      targetLanes: ["es", "de"],
      defaultLaneLabel: "French",
      defaultLaneFallback: fallback,
      allowedTags: [""],
    })
    expect(items).toEqual([{ value: DEFAULT_LANE_SELECT_VALUE, label: "French" }])
  })

  it("pre-fills one lane, the lane the user arrived from, and nothing from All", () => {
    const one = [{ value: DEFAULT_LANE_SELECT_VALUE }]
    const several = [{ value: DEFAULT_LANE_SELECT_VALUE }, { value: "es" }]
    expect(initialAssignmentLane(one, null)).toBe(DEFAULT_LANE_SELECT_VALUE)
    expect(initialAssignmentLane(several, "es")).toBe("es")
    expect(initialAssignmentLane(several, "")).toBe(DEFAULT_LANE_SELECT_VALUE)
    expect(initialAssignmentLane(several, null)).toBeNull()
  })

  it("sends the lane id of the matching legacy tag, and nothing when the row is missing or ambiguous", () => {
    const rows = [
      { id: "lane-default", legacyTag: "" },
      { id: "lane-es", legacyTag: "es" },
    ]
    expect(laneIdForTag(undefined, rows)).toBe("lane-default")
    expect(laneIdForTag("es", rows)).toBe("lane-es")
    expect(laneIdForTag("es", [])).toBeUndefined()
    expect(laneIdForTag("es", [
      { id: "a", legacyTag: "es" },
      { id: "b", legacyTag: "es" },
    ])).toBeUndefined()
  })
})
