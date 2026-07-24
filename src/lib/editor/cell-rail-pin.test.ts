// AQU-621 regression guard: a focused cell keeps its action rail pinned (so it
// never idle-collapses to a blank rail), while AQU-354's conflict-banner case
// still lets the rail collapse so the Discard button underneath stays reachable.
import { describe, it, expect } from "vitest"
import {
  computeRailPinned,
  isRailFocusPinned,
  railFocusOwnerOnBlur,
  railFocusOwnerOnFocus,
  type RailPinInputs,
} from "./cell-rail-pin"

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

// AQU-669: the focus pin is exclusive — at most one cell is pinned at a time,
// and focusing another cell un-pins the previous one deterministically (without
// relying on the previous row's focus-out ever firing).
describe("exclusive rail focus owner (AQU-669)", () => {
  it("isRailFocusPinned is true only for the current owner", () => {
    expect(isRailFocusPinned("cell-a", "cell-a")).toBe(true)
    expect(isRailFocusPinned("cell-a", "cell-b")).toBe(false)
    expect(isRailFocusPinned(null, "cell-a")).toBe(false)
  })

  it("focusing a cell makes it the sole owner (a focus-in always wins)", () => {
    expect(railFocusOwnerOnFocus(null, "cell-a")).toBe("cell-a")
    expect(railFocusOwnerOnFocus("cell-a", "cell-b")).toBe("cell-b")
  })

  it("the previous cell is no longer pinned once another cell is focused", () => {
    // Row 1 focused → row 1 pinned, no other row pinned.
    let owner: string | null = railFocusOwnerOnFocus(null, "cell-1")
    expect(isRailFocusPinned(owner, "cell-1")).toBe(true)

    // Focus row 2 (row 1's focus-out has NOT fired yet — the accumulation bug).
    owner = railFocusOwnerOnFocus(owner, "cell-2")
    expect(isRailFocusPinned(owner, "cell-1")).toBe(false) // row 1 un-pinned
    expect(isRailFocusPinned(owner, "cell-2")).toBe(true)

    // Focus row 3 the same way: still exactly one pinned rail.
    owner = railFocusOwnerOnFocus(owner, "cell-3")
    expect(isRailFocusPinned(owner, "cell-1")).toBe(false)
    expect(isRailFocusPinned(owner, "cell-2")).toBe(false)
    expect(isRailFocusPinned(owner, "cell-3")).toBe(true)
  })

  it("blur clears the owner only when the leaving row still holds it", () => {
    // Focus fully leaves the grid (e.g. clicking the sidebar): owner clears.
    expect(railFocusOwnerOnBlur("cell-a", "cell-a")).toBeNull()
    // Out-of-order focus-out from a row that was already superseded is ignored,
    // so the just-focused row keeps its pin.
    expect(railFocusOwnerOnBlur("cell-b", "cell-a")).toBe("cell-b")
    expect(railFocusOwnerOnBlur(null, "cell-a")).toBeNull()
  })
})
