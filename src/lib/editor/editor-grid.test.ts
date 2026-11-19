import { describe, expect, it } from "vitest"
import { editorGridCols, editorGridStyle, editorHeaderGridCols } from "./editor-grid"

describe("editor grid template", () => {
  it("keeps the three-track template without Bible columns, and reads one shared variable with them", () => {
    expect(editorGridCols(false, 0)).toBe("grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[84px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]")
    expect(editorHeaderGridCols(true, 0)).toBe("md:grid-cols-[132px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]")
    expect(editorGridStyle(false, 0)).toBeUndefined()

    // Rows and headers read the same variable, so they cannot disagree.
    expect(editorGridCols(false, 2)).toContain("md:grid-cols-[var(--editor-grid-cols)]")
    expect(editorHeaderGridCols(false, 2)).toBe("md:grid-cols-[var(--editor-grid-cols)]")
    expect(editorGridStyle(false, 2)).toEqual({
      // AQU-2678: Source and the Bible columns share what Target leaves.
      "--editor-grid-cols": "84px minmax(0,var(--editor-rest-fr,1fr)) minmax(0,var(--editor-rest-fr,1fr)) minmax(0,var(--editor-rest-fr,1fr)) minmax(0,var(--editor-tgt-fr,1fr))",
    })
    expect(editorGridStyle(true, 1)).toEqual({ "--editor-grid-cols": "132px minmax(0,var(--editor-rest-fr,1fr)) minmax(0,var(--editor-rest-fr,1fr)) minmax(0,var(--editor-tgt-fr,1fr))" })
  })

  it("moves the action rail in by the back-translation track when that column is open", () => {
    // Source, Target, Back-translation: one track is (100% - 16px - two 8px
    // gaps) / 3; the rail ends flush with Target (16px padding + 8px gap).
    // The AQU-2678 split variables keep the shared tracks' fr sum at their
    // count, so the Back-translation track and this calc are unchanged.
    expect(editorGridStyle(false, 1, true)).toEqual({
      "--editor-grid-cols": "84px minmax(0,var(--editor-rest-fr,1fr)) minmax(0,var(--editor-tgt-fr,1fr)) minmax(0,1fr)",
      "--editor-rail-end": "calc((100% - 32px) / 3 + 24px)",
    })
    // Two Bible columns as well: five text tracks.
    expect(editorGridStyle(false, 3, true)?.["--editor-rail-end" as never]).toBe("calc((100% - 48px) / 5 + 24px)")
    // Bible columns alone leave the rail at the row's end.
    expect(editorGridStyle(false, 2)).not.toHaveProperty("--editor-rail-end")
  })
})
