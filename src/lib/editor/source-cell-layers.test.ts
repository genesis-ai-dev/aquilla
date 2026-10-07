import { describe, it, expect } from "vitest"
import {
  SOURCE_CELL_LAYERS,
  SOURCE_CELL_MENU_Z,
  SOURCE_SELECTION_RAIL_Z,
  zClassForLayer,
} from "./source-cell-layers"

describe("source cell corner layers (AQU-1134)", () => {
  it("paints the term action rail in front of the source cell menu trigger", () => {
    expect(SOURCE_CELL_LAYERS.selectionRail).toBeGreaterThan(SOURCE_CELL_LAYERS.cellMenu)
  })

  it("never lets the two share a layer", () => {
    // The original bug: both were z-10, so painting order fell through to DOM
    // order and the menu (rendered later) covered the rail.
    expect(SOURCE_CELL_LAYERS.selectionRail).not.toBe(SOURCE_CELL_LAYERS.cellMenu)
  })

  it("keeps the Tailwind classes in step with the layer numbers", () => {
    expect(SOURCE_SELECTION_RAIL_Z).toBe(zClassForLayer(SOURCE_CELL_LAYERS.selectionRail))
    expect(SOURCE_CELL_MENU_Z).toBe(zClassForLayer(SOURCE_CELL_LAYERS.cellMenu))
  })
})
