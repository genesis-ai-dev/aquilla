import { describe, expect, it } from "vitest"
import { lineName, readLineNumbering } from "./line-name"
import { createEditorStructureCache } from "@/lib/editor-structure-cache"
import { lineStore, type TestLine } from "@/test-utils/line-store"
import type { CellStore } from "@/hooks/useActiveCellStore"
import type { OrderedBy } from "@/lib/parsers/types"

// AQU-1722 / AQU-2278: the one rule for what a line is called in a list.
function namesOf(store: CellStore, orderedBy?: OrderedBy): Map<string, string> {
  const rowIds = store.getCellIdsForLens(orderedBy)
  const numbering = readLineNumbering(store, rowIds, createEditorStructureCache())
  return new Map(rowIds.map((id) => [id, lineName(store.getCellView(id)!, numbering, (n) => `row ${n}`)]))
}

describe("lineName", () => {
  it("names a Bible line by its reference, a split verse by its part, and a heading by nothing", () => {
    const lines: TestLine[] = [
      { id: "title", type: "heading", ref: "RUT 1:h:1", text: "Naomi and Ruth" },
      { id: "v4", ref: "RUT 1:4" },
      { id: "v5", ref: "RUT 1:5" },
      { id: "v5-b", splitFrom: "v5" },
      { id: "v5-c", splitFrom: "v5" },
      { id: "v6", ref: "RUT 1:6" },
    ]
    const names = namesOf(lineStore(lines))
    // A structure locator is where a heading sits, not a name; a heading has
    // no # either, so it is unnamed, as it is in the table.
    expect(names.get("title")).toBe("")
    expect(names.get("v4")).toBe("RUT 1:4")
    // The gutter reads 5a / 5b / 5c; the pieces carry no reference of their own.
    expect(names.get("v5")).toBe("RUT 1:5a")
    expect(names.get("v5-b")).toBe("RUT 1:5b")
    expect(names.get("v5-c")).toBe("RUT 1:5c")
    expect(names.get("v6")).toBe("RUT 1:6")
  })

  it("names a line with no reference by the table's # column, skipping headings and hidden lines", () => {
    const lines: TestLine[] = [
      { id: "h", type: "heading" },
      { id: "p1" },
      { id: "gone", hidden: true },
      { id: "p2" },
    ]
    const store = lineStore(lines)
    const names = namesOf(store)
    expect(names.get("h")).toBe("")
    expect(names.get("p1")).toBe("row 1")
    expect(names.get("p2")).toBe("row 2")
    expect(names.has("gone")).toBe(false)
  })

  it("numbers a time-ordered file in play order, not the order its lines were added", () => {
    const lines: TestLine[] = [
      { id: "late", startMs: 9000 },
      { id: "early", startMs: 1000 },
      { id: "middle", startMs: 5000 },
    ]
    const store = lineStore(lines)
    const rowIds = store.getCellIdsForLens("time")
    expect(rowIds).toEqual(["early", "middle", "late"])
    const numbering = readLineNumbering(store, rowIds, createEditorStructureCache())
    expect(numbering.sequentialNumberByCellId.get("early")).toBe(1)
    expect(numbering.sequentialNumberByCellId.get("late")).toBe(3)
    // A cue's timing is the reference it is known by.
    expect(namesOf(store, "time").get("early")).toBe("00:00:01.000 --> 00:00:02.000")
  })
})
