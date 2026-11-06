/**
 * AQU-2408 — `buildCellData` maps the SOURCE row's `metadata.cellLabel` onto
 * `CellData.cellLabel`: the key a typed label (`cell.label.set`) writes and the
 * one legacy Codex notebooks already carry. Strict: a non-string or blank
 * value is no label, and the target row's bucket never supplies one.
 */
import { describe, it, expect } from "vitest"
import { buildCellData } from "./useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"

function row(over: Partial<CellRow>): CellRow {
  return {
    cellId: "c1", side: "source", value: "Hi", valueHtml: null, type: "text",
    canonicalRef: null, anchorCellId: null, eventId: "e1", sourceEventId: null,
    lastEditor: null, lastEditAt: 0, validated: false, wordCount: 1, ...over,
  }
}

describe("buildCellData — cellLabel (AQU-2408)", () => {
  it("maps a typed label on the source row, trimmed", () => {
    const cell = buildCellData("c1", row({ metadata: { cellLabel: "  Pericope  " } }), undefined, "f1", "u", 1, undefined)
    expect(cell.cellLabel).toBe("Pericope")
  })

  it("keeps the label a legacy Codex notebook carried in the same key", () => {
    const cell = buildCellData("c1", row({ metadata: { cellLabel: "MARY MAGDALENE", cast_name: "Mary" } }), undefined, "f1", "u", 1, undefined)
    expect(cell.cellLabel).toBe("MARY MAGDALENE")
  })

  it("is absent when the row has no metadata, no key, a blank or a non-string value", () => {
    expect(buildCellData("c1", row({}), undefined, "f1", "u", 1, undefined).cellLabel).toBeUndefined()
    expect(buildCellData("c1", row({ metadata: { paragraphStart: true } }), undefined, "f1", "u", 1, undefined).cellLabel).toBeUndefined()
    expect(buildCellData("c1", row({ metadata: { cellLabel: "   " } }), undefined, "f1", "u", 1, undefined).cellLabel).toBeUndefined()
    expect(buildCellData("c1", row({ metadata: { cellLabel: 42 } }), undefined, "f1", "u", 1, undefined).cellLabel).toBeUndefined()
    expect("cellLabel" in buildCellData("c1", row({}), undefined, "f1", "u", 1, undefined)).toBe(false)
  })

  it("reads the source row only — a target-side bucket never labels the cell", () => {
    const target = row({ side: "target", eventId: "t1", metadata: { cellLabel: "nope" } })
    expect(buildCellData("c1", row({}), target, "f1", "u", 1, undefined).cellLabel).toBeUndefined()
    expect(buildCellData("c1", undefined, target, "f1", "u", 1, undefined).cellLabel).toBeUndefined()
  })
})
