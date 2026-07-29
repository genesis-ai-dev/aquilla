import { describe, it, expect } from "vitest"
import { buildBookPunchList } from "./book-punchlist"
import type { CellRow } from "@/lib/sync/cells-read-types"

// Minimal CellRow factory — only the fields the punch list reads.
function cell(over: Partial<CellRow> & Pick<CellRow, "cellId" | "side">): CellRow {
  return {
    value: "",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: "e",
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 0,
    ...over,
  } as CellRow
}

// A book with:
//  GEN 1:1 — validated (excluded)
//  GEN 1:2 — translated by randall, NOT validated
//  GEN 1:3 — translated by randall, NOT validated
//  GEN 2:1 — translated by cleiton, NOT validated
//  GEN 2:2 — never translated (no target row)
//  EXO 1:1 — different book, unvalidated (must be excluded by bookCode filter)
function seededRows(): CellRow[] {
  return [
    cell({ cellId: "g-1-1", side: "source", canonicalRef: "GEN 1:1" }),
    cell({ cellId: "g-1-1", side: "target", value: "v", lastEditor: "randall", validated: true }),
    cell({ cellId: "g-1-2", side: "source", canonicalRef: "GEN 1:2" }),
    cell({ cellId: "g-1-2", side: "target", value: "v", lastEditor: "randall", validated: false }),
    cell({ cellId: "g-1-3", side: "source", canonicalRef: "GEN 1:3" }),
    cell({ cellId: "g-1-3", side: "target", value: "v", lastEditor: "randall", validated: false }),
    cell({ cellId: "g-2-1", side: "source", canonicalRef: "GEN 2:1" }),
    cell({ cellId: "g-2-1", side: "target", value: "v", lastEditor: "cleiton", validated: false }),
    cell({ cellId: "g-2-2", side: "source", canonicalRef: "GEN 2:2" }),
    cell({ cellId: "e-1-1", side: "source", canonicalRef: "EXO 1:1" }),
    cell({ cellId: "e-1-1", side: "target", value: "v", lastEditor: "randall", validated: false }),
  ]
}

describe("buildBookPunchList", () => {
  it("lists only unvalidated cells in the target book, grouped by last editor", () => {
    const pl = buildBookPunchList(seededRows(), "GEN")
    expect(pl.bookCode).toBe("GEN")
    // GEN 1:1 validated → excluded; EXO 1:1 different book → excluded.
    // Remaining: g-1-2, g-1-3 (randall), g-2-1 (cleiton), g-2-2 (untranslated).
    expect(pl.totalUnvalidated).toBe(4)

    // Largest offender (randall, 2) first; untranslated bucket (null) last.
    expect(pl.groups.map((g) => g.editor)).toEqual(["randall", "cleiton", null])
    expect(pl.groups[0].count).toBe(2)
    expect(pl.groups[0].cells.map((c) => c.ref)).toEqual(["GEN 1:2", "GEN 1:3"])
    expect(pl.groups[0].cells.every((c) => c.filled)).toBe(true)
  })

  it("puts never-translated cells in a null-editor bucket flagged unfilled", () => {
    const pl = buildBookPunchList(seededRows(), "GEN")
    const untranslated = pl.groups.find((g) => g.editor === null)!
    expect(untranslated.cells.map((c) => c.cellId)).toEqual(["g-2-2"])
    expect(untranslated.cells[0].filled).toBe(false)
    expect(untranslated.cells[0].ref).toBe("GEN 2:2")
  })

  it("returns an empty punch list when every cell in the book is validated", () => {
    const rows = [
      cell({ cellId: "g-1-1", side: "source", canonicalRef: "GEN 1:1" }),
      cell({ cellId: "g-1-1", side: "target", value: "v", lastEditor: "x", validated: true }),
    ]
    const pl = buildBookPunchList(rows, "GEN")
    expect(pl.totalUnvalidated).toBe(0)
    expect(pl.groups).toEqual([])
  })

  it("falls back to the source canonical_ref when the target row's is null", () => {
    const rows = [
      cell({ cellId: "g-1-2", side: "source", canonicalRef: "GEN 1:2" }),
      // target has NO canonicalRef (typical — target-side ref is often NULL).
      cell({ cellId: "g-1-2", side: "target", value: "v", canonicalRef: null, lastEditor: "randall", validated: false }),
    ]
    const pl = buildBookPunchList(rows, "GEN")
    expect(pl.totalUnvalidated).toBe(1)
    expect(pl.groups[0].cells[0].ref).toBe("GEN 1:2")
  })

  it("orders cells within a group canonically (chapter then verse, numeric)", () => {
    const rows = [
      cell({ cellId: "a", side: "source", canonicalRef: "GEN 10:1" }),
      cell({ cellId: "a", side: "target", value: "v", lastEditor: "z", validated: false }),
      cell({ cellId: "b", side: "source", canonicalRef: "GEN 2:1" }),
      cell({ cellId: "b", side: "target", value: "v", lastEditor: "z", validated: false }),
      cell({ cellId: "c", side: "source", canonicalRef: "GEN 2:10" }),
      cell({ cellId: "c", side: "target", value: "v", lastEditor: "z", validated: false }),
    ]
    const pl = buildBookPunchList(rows, "GEN")
    expect(pl.groups[0].cells.map((c) => c.ref)).toEqual(["GEN 2:1", "GEN 2:10", "GEN 10:1"])
  })
})
