/**
 * AQU-990 — the importer must reject an oversized cell before uploading, and
 * say which cell it was. Previously the whole payload was chunked and uploaded
 * and the user got a bare `Upload failed (HTTP 413)` with no cell named.
 */

import { describe, expect, it } from "vitest"
import { MAX_CELL_TEXT_BYTES } from "../../../shared/import-contract"
import type { BulkImportCell, TargetCommit } from "../sync/bulk-import"
import { assertImportCellsWithinSizeLimit, findOversizedImportCells } from "./cell-size"

function cell(overrides: Partial<BulkImportCell> & { cellId: string }): BulkImportCell {
  return {
    id: `event-${overrides.cellId}`,
    anchorCellId: null,
    value: "fits",
    ...overrides,
  }
}

/** `MAX_CELL_TEXT_BYTES + 1` bytes of single-byte characters. */
const OVERSIZED = "a".repeat(MAX_CELL_TEXT_BYTES + 1)
/** Multi-byte: 3 bytes per character, so this is over the limit on bytes while
 *  its `.length` is comfortably under it — the limit is measured in UTF-8. */
const OVERSIZED_MULTIBYTE = "あ".repeat(Math.ceil(MAX_CELL_TEXT_BYTES / 3) + 1)

describe("findOversizedImportCells", () => {
  it("passes a payload whose every cell fits", () => {
    expect(findOversizedImportCells([
      cell({ cellId: "a" }),
      cell({ cellId: "b", value: "x".repeat(MAX_CELL_TEXT_BYTES) }),
    ])).toEqual([])
  })

  it("flags an oversized source cell with its size and position", () => {
    const found = findOversizedImportCells([
      cell({ cellId: "a" }),
      cell({ cellId: "b", value: OVERSIZED }),
    ])
    expect(found).toEqual([
      { cellId: "b", side: "source", bytes: MAX_CELL_TEXT_BYTES + 1, label: "#2" },
    ])
  })

  it("measures UTF-8 bytes, not characters", () => {
    expect(OVERSIZED_MULTIBYTE.length).toBeLessThan(MAX_CELL_TEXT_BYTES)
    const found = findOversizedImportCells([cell({ cellId: "a", value: OVERSIZED_MULTIBYTE })])
    expect(found).toHaveLength(1)
    expect(found[0]!.bytes).toBeGreaterThan(MAX_CELL_TEXT_BYTES)
  })

  it("flags an oversized valueHtml even when the plain text fits", () => {
    const found = findOversizedImportCells([
      cell({ cellId: "a", value: "short", valueHtml: `<p>${OVERSIZED}</p>` }),
    ])
    expect(found).toMatchObject([{ cellId: "a", side: "source" }])
  })

  it("prefers a canonical reference over the positional label", () => {
    const found = findOversizedImportCells([
      cell({ cellId: "a", canonicalRef: "LUK 1:1", value: OVERSIZED }),
    ])
    expect(found[0]!.label).toBe("LUK 1:1")
  })

  it("flags an oversized paired target and labels it from its source cell", () => {
    const cells = [cell({ cellId: "a", canonicalRef: "LUK 1:1" })]
    const targets: TargetCommit[] = [
      { id: "t1", cellId: "a", parentId: "event-a", value: OVERSIZED },
    ]
    expect(findOversizedImportCells(cells, targets)).toEqual([
      { cellId: "a", side: "target", bytes: MAX_CELL_TEXT_BYTES + 1, label: "LUK 1:1" },
    ])
  })
})

describe("assertImportCellsWithinSizeLimit", () => {
  it("is a no-op when everything fits", () => {
    expect(() => assertImportCellsWithinSizeLimit("ok.idml", [cell({ cellId: "a" })])).not.toThrow()
  })

  it("names the file, the limit and the offending cell", () => {
    expect(() => assertImportCellsWithinSizeLimit("TokPisinBible.idml", [
      cell({ cellId: "a" }),
      cell({ cellId: "b", value: OVERSIZED }),
    ])).toThrow(/TokPisinBible\.idml.*256 KB.*#2/s)
  })

  it("reports every offender but lists only the first few by name", () => {
    const cells = Array.from({ length: 6 }, (_, index) => cell({
      cellId: `c${index}`,
      value: OVERSIZED,
    }))
    let message = ""
    try {
      assertImportCellsWithinSizeLimit("big.idml", cells)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("6 cells")
    expect(message).toContain("#1")
    expect(message).toContain("#3")
    expect(message).not.toContain("#4")
    expect(message).toContain("and 3 more")
  })

  it("distinguishes a too-large translation from a too-large source", () => {
    expect(() => assertImportCellsWithinSizeLimit(
      "paired.xlsx",
      [cell({ cellId: "a" })],
      [{ id: "t1", cellId: "a", parentId: "event-a", value: OVERSIZED }],
    )).toThrow(/translation/)
  })
})
