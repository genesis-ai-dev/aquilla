import { describe, it, expect } from "vitest"
import { DEFAULT_MILESTONE_FLOOR, milestoneFloorLevel } from "./milestone-floor"
import { PROJECT_SETTINGS_KEY_SPECS, validateSettingsKeyValue } from "./project-settings-keys"

describe("milestoneFloor (AQU-2309)", () => {
  it("admits maintainers only when the key is absent or unrecognised", () => {
    expect(DEFAULT_MILESTONE_FLOOR).toBe(600)
    const closed = [
      undefined,
      null,
      "maintainer",
      "contributor",
      "none",
      "lane_lead",
      500,
      true,
    ]
    for (const tier of closed) {
      expect(milestoneFloorLevel(tier)).toBe(600)
    }
  })

  it("admits a project lead only for the project_lead rung", () => {
    expect(milestoneFloorLevel("project_lead")).toBe(500)
  })

  it("is a known settings key with exactly the two rungs", () => {
    expect(PROJECT_SETTINGS_KEY_SPECS.milestoneFloor).toEqual({
      kind: "enum",
      values: ["maintainer", "project_lead"],
    })
    expect(validateSettingsKeyValue("milestoneFloor", "project_lead")).toBeNull()
    expect(validateSettingsKeyValue("milestoneFloor", "maintainer")).toBeNull()
    expect(validateSettingsKeyValue("milestoneFloor", "contributor")).not.toBeNull()
    expect(validateSettingsKeyValue("milestoneFloor", "none")).not.toBeNull()
  })
})
