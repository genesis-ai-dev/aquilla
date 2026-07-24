/**
 * p1-paragraph-ui-wiring / Task 1.
 *
 * `buildCellData` must map the SOURCE row's `metadata.paragraphStart` onto
 * `CellData.paragraphStart` with a strict boolean check — `metadata` is
 * `Record<string, unknown>`, so anything other than the literal `true` must
 * not leak through as truthy (a stray string/number in the bag must not
 * make a cell falsely look like a paragraph start).
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

describe("buildCellData — paragraphStart (D1)", () => {
  it("maps metadata.paragraphStart === true on the source row to CellData.paragraphStart", () => {
    const cell = buildCellData("c1", row({ metadata: { paragraphStart: true } }), undefined, "f1", "u", 1, undefined)
    expect(cell.paragraphStart).toBe(true)
  })

  it("is undefined when the source row has no metadata", () => {
    const cell = buildCellData("c1", row({}), undefined, "f1", "u", 1, undefined)
    expect(cell.paragraphStart).toBeUndefined()
  })

  it("is undefined when metadata is present but lacks paragraphStart", () => {
    const cell = buildCellData(
      "c1",
      row({ metadata: { attachments: [] } }),
      undefined,
      "f1",
      "u",
      1,
      undefined,
    )
    expect(cell.paragraphStart).toBeUndefined()
  })

  it("is undefined (not truthy-coerced) when metadata.paragraphStart is non-boolean junk", () => {
    const cell = buildCellData(
      "c1",
      row({ metadata: { paragraphStart: "true" } }),
      undefined,
      "f1",
      "u",
      1,
      undefined,
    )
    expect(cell.paragraphStart).toBeUndefined()
  })

  it("is undefined when metadata.paragraphStart is explicitly false", () => {
    const cell = buildCellData(
      "c1",
      row({ metadata: { paragraphStart: false } }),
      undefined,
      "f1",
      "u",
      1,
      undefined,
    )
    expect(cell.paragraphStart).toBeUndefined()
  })

  it("does NOT read paragraphStart from the target row — source-only signal", () => {
    const cell = buildCellData(
      "c1",
      row({ side: "source" }),
      row({ side: "target", value: "Translated", metadata: { paragraphStart: true } }),
      "f1",
      "u",
      1,
      undefined,
    )
    expect(cell.paragraphStart).toBeUndefined()
  })
})
