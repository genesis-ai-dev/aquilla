// AQU-621 regression guard: a focused cell keeps its action rail pinned (so it
// never idle-collapses to a blank rail), while AQU-354's conflict-banner case
// still lets the rail collapse so the Discard button underneath stays reachable.
import { describe, it, expect } from "vitest"
import { computeRailPinned, type RailPinInputs } from "./cell-rail-pin"

const base: RailPinInputs = {
  expanded: false,
  railHasFocus: false,
  showMicDeniedHelp: false,
  showGenerateConfirm: false,
  hasFocusWithin: false,
  remoteChangedWhileFocused: false,
}

describe("computeRailPinned", () => {
  it("is not pinned when the row is idle (no focus / interaction)", () => {
    expect(computeRailPinned(base)).toBe(false)
  })

  it("AQU-621: pins while focus is within the row (the target cell is focused)", () => {
    expect(computeRailPinned({ ...base, hasFocusWithin: true })).toBe(true)
  })

  it("AQU-354: does NOT pin on focus while the conflict banner is showing", () => {
    expect(
      computeRailPinned({
        ...base,
        hasFocusWithin: true,
        remoteChangedWhileFocused: true,
      }),
    ).toBe(false)
  })

  it("still pins in-flight interactions even during the conflict banner", () => {
    for (const key of [
      "expanded",
      "railHasFocus",
      "showMicDeniedHelp",
      "showGenerateConfirm",
    ] as const) {
      expect(
        computeRailPinned({
          ...base,
          [key]: true,
          remoteChangedWhileFocused: true,
        }),
      ).toBe(true)
    }
  })
})
