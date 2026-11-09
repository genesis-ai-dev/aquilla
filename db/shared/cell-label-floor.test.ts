import { describe, it, expect } from "vitest"
import { DEFAULT_CELL_LABEL_FLOOR, cellLabelFloorFromSettings } from "./cell-label-floor"
import { PROJECT_SETTINGS_KEY_SPECS, validateSettingsKeyValue } from "./project-settings-keys"

describe("cellLabelFloor (AQU-2408)", () => {
  it("admits maintainers only when the key is absent", () => {
    expect(DEFAULT_CELL_LABEL_FLOOR).toBe(600)
    expect(cellLabelFloorFromSettings(null)).toBe(600)
    expect(cellLabelFloorFromSettings(undefined)).toBe(600)
    expect(cellLabelFloorFromSettings({})).toBe(600)
    expect(cellLabelFloorFromSettings("maintainer")).toBe(600)
  })

  it("maps the two rungs", () => {
    expect(cellLabelFloorFromSettings({ cellLabelFloor: "maintainer" })).toBe(600)
    expect(cellLabelFloorFromSettings({ cellLabelFloor: "project_lead" })).toBe(500)
  })

  it("never reads an unknown value as a lower floor", () => {
    expect(cellLabelFloorFromSettings({ cellLabelFloor: "contributor" })).toBe(600)
    expect(cellLabelFloorFromSettings({ cellLabelFloor: "none" })).toBe(600)
    expect(cellLabelFloorFromSettings({ cellLabelFloor: 500 })).toBe(600)
  })

  it("is a known settings key with exactly the two rungs", () => {
    expect(PROJECT_SETTINGS_KEY_SPECS.cellLabelFloor).toEqual({ kind: "enum", values: ["maintainer", "project_lead"] })
    expect(validateSettingsKeyValue("cellLabelFloor", "project_lead")).toBeNull()
    expect(validateSettingsKeyValue("cellLabelFloor", "maintainer")).toBeNull()
    expect(validateSettingsKeyValue("cellLabelFloor", "contributor")).not.toBeNull()
    expect(validateSettingsKeyValue("cellLabelFloor", "none")).not.toBeNull()
  })
})
