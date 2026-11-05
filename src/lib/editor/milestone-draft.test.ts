// AQU-2308: the picker rows, the search and the prefill the dialog opens with.

import { describe, expect, it } from "vitest"

import {
  MILESTONE_PREVIEW_LENGTH,
  divisionsForOrder,
  milestoneDraftBadge,
  milestoneDraftLabel,
  milestoneDraftCells,
  milestoneDraftPrefill,
} from "./milestone-draft"

const order = ["c1", "c2", "c3", "c4", "c5"]

const text: Record<string, string> = {
  c1: "In the beginning",
  c2: "And the earth was without form",
  c3: "And God said, Let there be light",
  c4: "And God saw the light, that it was good",
  c5: "And God called the light Day",
}

const read = (cellId: string) => ({ text: text[cellId] })

describe("milestoneDraftCells", () => {
  it("numbers rows from 1 in display order and keeps the opening words", () => {
    const cells = milestoneDraftCells(order, read)
    expect(cells.map((c) => [c.lineNumber, c.cellId])).toEqual([
      [1, "c1"], [2, "c2"], [3, "c3"], [4, "c4"], [5, "c5"],
    ])
    expect(cells[0].preview).toBe("In the beginning")
  })

  it("caps the preview so a picker never carries whole verses", () => {
    const long = "word ".repeat(80)
    const [cell] = milestoneDraftCells(["c1"], () => ({ text: long }))
    expect(cell.preview.endsWith("…")).toBe(true)
    expect(cell.preview.length).toBeLessThanOrEqual(MILESTONE_PREVIEW_LENGTH + 1)
  })

  it("treats a blank or whitespace reference as having none", () => {
    const [blank] = milestoneDraftCells(["c1"], () => ({ reference: "   ", text: "x" }))
    expect(blank.reference).toBeNull()
    const [real] = milestoneDraftCells(["c1"], () => ({ reference: " MRK 4:35 ", text: "x" }))
    expect(real.reference).toBe("MRK 4:35")
  })

  it("survives a cell the store has nothing for", () => {
    const [cell] = milestoneDraftCells(["gone"], () => null)
    expect(cell).toEqual({ cellId: "gone", lineNumber: 1, reference: null, preview: "" })
  })
})

describe("milestoneDraftBadge", () => {
  it("leads with the file's reference when it has one, else the line number", () => {
    const [withRef] = milestoneDraftCells(["c1"], () => ({ reference: "MRK 4:35", text: "x" }))
    expect(milestoneDraftBadge(withRef)).toBe("MRK 4:35")
    const [plain] = milestoneDraftCells(order, read)
    expect(milestoneDraftBadge(plain)).toBe("1")
  })
})

describe("milestoneDraftLabel", () => {
  it("reads badge first, then the opening words", () => {
    const [cell] = milestoneDraftCells(["c1"], () => ({ reference: "MRK 4:35", text: "And he said" }))
    expect(milestoneDraftLabel(cell)).toBe("MRK 4:35 \u00b7 And he said")
  })

  it("is the badge alone on an empty cell, with no dangling separator", () => {
    const [cell] = milestoneDraftCells(["c1"], () => ({ text: "   " }))
    expect(milestoneDraftLabel(cell)).toBe("1")
  })

  it("carries the line number for a file that labels nothing", () => {
    const cells = milestoneDraftCells(order, read)
    expect(milestoneDraftLabel(cells[2])).toBe("3 \u00b7 And God said, Let there be light")
  })
})

describe("divisionsForOrder", () => {
  const entries = [
    { key: "part:1", label: "Part 1", shortLabel: "1", kind: "part" as const, cellIds: ["c1", "c2"] },
    { key: "scripture:MRK:4", label: "Mark 4", shortLabel: "4", kind: "chapter" as const, cellIds: ["c3", "c4"] },
  ]

  it("aligns one division per cell with the order given", () => {
    expect(divisionsForOrder(order, entries).map((d) => d?.key))
      .toEqual(["part:1", "part:1", "scripture:MRK:4", "scripture:MRK:4", undefined])
  })

  it("carries the whole division identity, so a refusal can name it", () => {
    const [first] = divisionsForOrder(order, entries)
    expect(first).toEqual({ key: "part:1", kind: "part", label: "Part 1", shortLabel: "1" })
  })
})

describe("milestoneDraftPrefill", () => {
  it("prefills both edges from a shift-click selection", () => {
    const selected = new Set(["c2", "c3", "c4"])
    expect(milestoneDraftPrefill(order, "c3", selected))
      .toEqual({ startCellId: "c2", endCellId: "c4" })
  })

  it("reads the selection's edges in FILE order, not insertion order", () => {
    const selected = new Set(["c4", "c2"])
    expect(milestoneDraftPrefill(order, "c4", selected))
      .toEqual({ startCellId: "c2", endCellId: "c4" })
  })

  it("prefills a one-cell range from the clicked cell when nothing is selected", () => {
    expect(milestoneDraftPrefill(order, "c3", new Set()))
      .toEqual({ startCellId: "c3", endCellId: "c3" })
  })

  it("ignores a selection that does not contain the clicked cell", () => {
    expect(milestoneDraftPrefill(order, "c5", new Set(["c1", "c2"])))
      .toEqual({ startCellId: "c5", endCellId: "c5" })
  })

  it("ignores a one-cell selection, so the clicked row still wins", () => {
    expect(milestoneDraftPrefill(order, "c3", new Set(["c3"])))
      .toEqual({ startCellId: "c3", endCellId: "c3" })
  })
})
