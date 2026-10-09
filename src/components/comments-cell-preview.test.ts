import { describe, expect, it } from "vitest"
import { cellPlaceLabel, formatScriptureRef, placeLabelsByCell } from "./comments-cell-preview"

describe("comment cell place labels", () => {
  it("writes a canonical ref as book, chapter, and verse", () => {
    expect(formatScriptureRef("GEN 1:2")).toBe("Genesis 1:2")
    expect(formatScriptureRef("1SA 17:4")).toBe("1 Samuel 17:4")
    expect(formatScriptureRef("GEN 1")).toBe("Genesis 1")
    expect(formatScriptureRef("not a ref")).toBeNull()
  })

  it("uses the chapter label for a heading that has no verse", () => {
    expect(cellPlaceLabel({
      cellId: "heading",
      side: "source",
      canonicalRef: null,
      metadata: {
        aquillaImport: {
          address: { index: 1, scheme: "sequence" },
          milestone: { label: "Genesis 1", kind: "chapter" },
        },
      },
    })).toBe("Genesis 1")
  })

  it("prefers the source row's verse over the target row", () => {
    const labels = placeLabelsByCell([
      { cellId: "c1", side: "target", canonicalRef: null },
      { cellId: "c1", side: "source", canonicalRef: "GEN 1:2" },
    ])
    expect(labels.get("c1")).toBe("Genesis 1:2")
  })
})