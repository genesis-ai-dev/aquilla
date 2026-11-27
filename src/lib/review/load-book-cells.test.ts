import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { pairBookRows } from "./load-book-cells"

function row(over: Partial<CellRow> & Pick<CellRow, "cellId" | "side" | "value">): CellRow {
  return {
    valueHtml: null,
    type: "verse",
    canonicalRef: null,
    anchorCellId: null,
    eventId: `e-${over.cellId}-${over.side}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 1,
    ...over,
  }
}

describe("pairBookRows", () => {
  it("keeps the active language and pairs source with target", () => {
    const cells = pairBookRows([
      row({ cellId: "v1", side: "source", value: "In the beginning", canonicalRef: "GEN 1:1" }),
      row({ cellId: "v1", side: "target", value: "Au commencement", targetLang: "fr", aiDrafted: true }),
      row({ cellId: "v1", side: "target", value: "Al principio", targetLang: "es" }),
      row({ cellId: "v2", side: "source", value: "God created", canonicalRef: "GEN 1:2" }),
    ], "genesis", "fr", "me", 1, new Map())
    expect(cells.map((cell) => [cell.id, cell.original, cell.translated, cell.group])).toEqual([
      ["v1", "In the beginning", "Au commencement", "GEN 1:1"],
      ["v2", "God created", "", "GEN 1:2"],
    ])
    expect(cells[0].aiDrafted).toBe(true)
    expect(cells[0].fileId).toBe("genesis")
  })
})
