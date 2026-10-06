// decision-context helpers. WHY: a question card must show the verses it is
// about and, on request, the verses around them — in document order and in
// the default lane. Getting the window or the pairing wrong shows a reader the
// wrong text next to a question they are being asked to settle.

import { describe, it, expect } from "vitest"
import { pairCells, windowAround } from "./decision-context"
import type { CellRow } from "@/lib/sync/cells-read-types"

function row(cellId: string, side: "source" | "target", value: string, extra: Partial<CellRow> = {}): CellRow {
  return {
    cellId, side, value, valueHtml: null, type: null, canonicalRef: null, anchorCellId: null,
    eventId: "e", sourceEventId: null, lastEditor: null, lastEditAt: 0, validated: false,
    wordCount: 0, ...extra,
  } as CellRow
}

describe("windowAround", () => {
  const order = ["a", "b", "c", "d", "e", "f", "g"]

  it("spans the affected cells plus the radius on each side", () => {
    expect(windowAround(order, ["d"], 2)).toEqual(["b", "c", "d", "e", "f"])
    expect(windowAround(order, ["c", "e"], 1)).toEqual(["b", "c", "d", "e", "f"])
  })

  it("clamps at the file's edges", () => {
    expect(windowAround(order, ["a"], 3)).toEqual(["a", "b", "c", "d"])
    expect(windowAround(order, ["g"], 3)).toEqual(["d", "e", "f", "g"])
  })

  it("returns nothing when no affected cell is still in the file", () => {
    expect(windowAround(order, ["gone"], 3)).toEqual([])
  })
})

describe("pairCells", () => {
  it("pairs source with the default-lane translation and marks affected cells", () => {
    const rows = [
      row("a", "source", "In the beginning", { canonicalRef: "GEN 1:1" }),
      row("a", "target", "Au commencement"),
      row("a", "target", "Im Anfang", { targetLang: "de" }),
      row("b", "source", "And the earth", { canonicalRef: "GEN 1:2" }),
    ]
    expect(pairCells(rows, ["a", "b"], new Set(["b"]))).toEqual([
      { cellId: "a", ref: "GEN 1:1", source: "In the beginning", target: "Au commencement", affected: false },
      { cellId: "b", ref: "GEN 1:2", source: "And the earth", target: "", affected: true },
    ])
  })
})
