import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { setCellWaivers, readCellWaivers } from "./useCellWaivers"
import type { RuleWaiver } from "@/lib/parsers/types"

function seed(doc: Y.Doc, cellId: string) {
  const cellsMap = doc.getMap("cells")
  const cell = new Y.Map<unknown>()
  cell.set("id", cellId)
  cellsMap.set(cellId, cell)
}

describe("cell waivers", () => {
  it("writes and reads a single waiver round-trip", () => {
    const doc = new Y.Doc()
    seed(doc, "c1")
    const waiver: RuleWaiver = { ruleId: "r1", reason: "ok here", waivedAt: "2026-04-24T00:00:00Z" }
    setCellWaivers(doc, "c1", [waiver])
    expect(readCellWaivers(doc, "c1")).toEqual([waiver])
  })

  it("treats missing field as empty array", () => {
    const doc = new Y.Doc()
    seed(doc, "c1")
    expect(readCellWaivers(doc, "c1")).toEqual([])
  })

  it("is a no-op when the cell does not exist", () => {
    const doc = new Y.Doc()
    setCellWaivers(doc, "missing", [{ ruleId: "r1", waivedAt: "x" }])
    expect(readCellWaivers(doc, "missing")).toEqual([])
  })
})
