import { describe, expect, it } from "vitest"
import {
  cellNumberLabel,
  chapterLabelFromCanonical,
  parseScriptureReference,
  verseLabelFromCanonical,
} from "./scripture-reference"

describe("scripture references", () => {
  it("parses canonical refs and resolves the friendly book name", () => {
    expect(parseScriptureReference("MAT 12:4a")).toEqual({
      bookCode: "MAT",
      bookName: "Matthew",
      chapter: "12",
      verse: "4a",
    })
  })

  it("preserves verse ranges for gutter labels", () => {
    expect(verseLabelFromCanonical("GEN 1:1-3")).toBe("1-3")
  })

  it("formats chapter-only section labels", () => {
    expect(chapterLabelFromCanonical("2PE 3")).toBe("2 Peter 3")
  })

  it("does not turn headings or arbitrary rows into verse labels", () => {
    expect(verseLabelFromCanonical("GEN 1:h:1")).toBeNull()
    expect(parseScriptureReference("Row 7")).toBeNull()
  })

  it("keeps Paratext headings unnumbered without shifting later verses", () => {
    const rows = [
      { cellType: "heading", canonicalRef: "GEN 1:s1:1" },
      { cellType: "verse", canonicalRef: "GEN 1:1" },
      { cellType: "verse", canonicalRef: "GEN 1:2" },
      { cellType: "verse", canonicalRef: "GEN 1:13" },
    ]

    expect(rows.map((row, rowIndex) => cellNumberLabel({
      lineNumbersEnabled: true,
      scriptureNumbering: true,
      rowIndex,
      ...row,
    }))).toEqual([null, "1", "2", "13"])
  })

  it("uses the source verse reference for a paired target row", () => {
    expect(cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: "verse",
      canonicalRef: null,
      sourceCanonicalRef: "GEN 1:31",
      scriptureNumbering: true,
      rowIndex: 39,
    })).toBe("31")
  })

  it("retains ordinal labels for ordinary non-scripture cells", () => {
    expect(cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: "text",
      canonicalRef: null,
      scriptureNumbering: false,
      rowIndex: 8,
    })).toBe("9")
  })
})
