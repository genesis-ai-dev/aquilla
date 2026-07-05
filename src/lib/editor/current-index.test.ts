// WHY: "Next unfinished" resolves the user's current position through this
// function. The active-cell preference is what lets repeat-clicks skip past a
// just-jumped-to cell — the jump centers its target (viewPosition 0.5), so
// resolving from the first visible row would re-find the same cell forever.
import { describe, it, expect } from "vitest"
import { resolveCurrentCellIndex, type VirtualListMeasurements } from "./current-index"

const cellIds = (ids: string[]) => ids.map((id) => ({ id }))

/** Uniform 100px rows so positions are easy to reason about. */
const uniformRows = (scroll: number): VirtualListMeasurements => ({
  scroll,
  positionAtIndex: (index) => index * 100,
  sizeAtIndex: () => 100,
})

const CELLS = cellIds(["a", "b", "c", "d", "e"])

const base = {
  displayCells: CELLS,
  cells: CELLS,
  activeCellId: null as string | null,
  viewableIndexes: [] as number[],
  measurements: null as VirtualListMeasurements | null,
  fallbackScrollTop: 0,
  estimatedRowHeight: 100,
}

describe("resolveCurrentCellIndex", () => {
  it("returns 0 for an empty list", () => {
    expect(resolveCurrentCellIndex({ ...base, displayCells: [], cells: [] })).toBe(0)
  })

  it("prefers the active editor cell while it's on screen", () => {
    // Jump landed on "d" centered mid-viewport: rows b..e visible, scroll
    // still shows "b" first. Searching from "d" (not "b") is what lets a
    // second click skip past "d".
    expect(
      resolveCurrentCellIndex({
        ...base,
        activeCellId: "d",
        viewableIndexes: [1, 2, 3, 4],
        measurements: uniformRows(150),
      }),
    ).toBe(3)
  })

  it("falls back to the viewport once the active cell scrolls off screen", () => {
    // User edited "a" then scrolled to the middle of the file — their
    // navigation position is where they're looking, not where they typed.
    expect(
      resolveCurrentCellIndex({
        ...base,
        activeCellId: "a",
        viewableIndexes: [2, 3, 4],
        measurements: uniformRows(250),
      }),
    ).toBe(2)
  })

  it("ignores an active cell that's no longer in the display list", () => {
    // e.g. the medium filter changed in time-ordered mode.
    expect(
      resolveCurrentCellIndex({
        ...base,
        displayCells: cellIds(["b", "c", "d"]),
        activeCellId: "a",
        viewableIndexes: [0, 1, 2],
        measurements: uniformRows(0),
      }),
    ).toBe(1) // display row 0 is "b" → cells index 1
  })

  it("resolves the first row whose bottom edge clears the scroll offset", () => {
    // scroll=150: row 0 spans 0-100 (fully above), row 1 spans 100-200 (partially visible).
    expect(resolveCurrentCellIndex({ ...base, measurements: uniformRows(150) })).toBe(1)
  })

  it("estimates from scrollTop when no virtualizer state is available", () => {
    expect(resolveCurrentCellIndex({ ...base, fallbackScrollTop: 320 })).toBe(3)
    // Clamped to the last row on overscroll.
    expect(resolveCurrentCellIndex({ ...base, fallbackScrollTop: 9999 })).toBe(4)
  })

  it("maps display space back to cells space in time-ordered mode", () => {
    // Display order re-sorted by timing: first visible display row is "e",
    // which lives at cells index 4.
    expect(
      resolveCurrentCellIndex({
        ...base,
        displayCells: cellIds(["e", "c", "a"]),
        measurements: uniformRows(0),
      }),
    ).toBe(4)
  })

  it("maps the active cell to cells space, not display space", () => {
    // Active cell "a" is display row 2 but cells index 0.
    expect(
      resolveCurrentCellIndex({
        ...base,
        displayCells: cellIds(["e", "c", "a"]),
        activeCellId: "a",
        viewableIndexes: [0, 1, 2],
        measurements: uniformRows(0),
      }),
    ).toBe(0)
  })
})
