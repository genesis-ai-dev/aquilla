import { describe, expect, it } from "vitest"
import { editorGridCols, editorGridStyle, editorHeaderGridCols } from "./editor-grid"

describe("editor grid template", () => {
  it("keeps the three-track template without Bible columns, and reads one shared variable with them", () => {
    expect(editorGridCols(false, 0)).toBe("grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)]")
    expect(editorHeaderGridCols(true, 0)).toBe("md:grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)]")
    expect(editorGridStyle(false, 0)).toBeUndefined()

    // Rows and headers read the same variable, so they cannot disagree.
    expect(editorGridCols(false, 2)).toContain("md:grid-cols-[var(--editor-grid-cols)]")
    expect(editorHeaderGridCols(false, 2)).toBe("md:grid-cols-[var(--editor-grid-cols)]")
    expect(editorGridStyle(false, 2)).toEqual({
      "--editor-grid-cols": "84px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)",
    })
    expect(editorGridStyle(true, 1)).toEqual({ "--editor-grid-cols": "132px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" })
  })
})
