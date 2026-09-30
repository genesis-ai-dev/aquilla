import { describe, expect, it } from "vitest"
import {
  DEFAULT_LANE_SELECT_VALUE,
  isDefaultLaneValue,
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
