import { describe, it, expect } from "vitest"
import { buildCellData } from "./useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"

function row(over: Partial<CellRow>): CellRow {
  return {
    cellId: "c1", side: "source", value: "Hi", valueHtml: null, type: "cue",
    canonicalRef: null, anchorCellId: null, eventId: "e1", sourceEventId: null,
    lastEditor: null, lastEditAt: 0, validated: false, wordCount: 1, ...over,
  }
}

describe("buildCellData timecodes", () => {
  it("maps startMs/endMs to seconds and rebuilds context as a VTT range", () => {
    const cell = buildCellData("c1", row({ startMs: 1500, endMs: 3250 }), undefined, "f1", "u", 1, undefined)
    expect(cell.startTime).toBeCloseTo(1.5)
    expect(cell.endTime).toBeCloseTo(3.25)
    expect(cell.context).toBe("00:00:01.500 --> 00:00:03.250")
  })

  it("leaves context empty and timecodes undefined when absent", () => {
    const cell = buildCellData("c1", row({}), undefined, "f1", "u", 1, undefined)
    expect(cell.startTime).toBeUndefined()
    expect(cell.context).toBe("")
  })

  it("exposes the untouched-machine-draft marker from the target projection", () => {
    const cell = buildCellData(
      "c1",
      row({ side: "source" }),
      row({ side: "target", value: "Borrador", aiDrafted: true }),
      "f1",
      "u",
      1,
      undefined,
    )
    expect(cell.aiDrafted).toBe(true)
  })
})
