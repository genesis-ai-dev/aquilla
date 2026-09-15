import { describe, expect, it } from "vitest"
import {
  cellNumberLabel,
  chapterLabelFromCanonical,
  importDisplayLabel,
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

  it("keeps a chapter-scoped heading unnumbered even when it carries a nearby verse ref", () => {
    expect(cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: "heading",
      canonicalRef: "GEN 1:1",
      sourceCanonicalRef: "GEN 1:1",
      scriptureNumbering: true,
      rowIndex: 0,
      displayLabel: null,
    })).toBeNull()
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

  // AQU-1068 review round. Matthew, via Ryder: adding a cell must not renumber
  // the existing ones. This is the DISPLAY half of that answer (the store half
  // lives in useActiveCellStore.insertPlan.test.ts): a number is read off the
  // cell's own reference or its import manifest, never off its position, so a
  // row inserted anywhere leaves every label around it untouched.
  it("keeps every imported label unchanged when a cell is inserted among them", () => {
    const label = (row: { canonicalRef: string | null; displayLabel?: string | null }, rowIndex: number) =>
      cellNumberLabel({
        lineNumbersEnabled: true,
        cellType: "verse",
        scriptureNumbering: true,
        rowIndex,
        ...row,
      })

    const before = [
      { canonicalRef: "GEN 1:1" },
      { canonicalRef: "GEN 1:2" },
      { canonicalRef: "GEN 1:3" },
    ]
    // The same file with a hand-added cell dropped in the middle. It carries
    // no reference and no import manifest, which is exactly why it takes no
    // number and steals none.
    const after = [
      { canonicalRef: "GEN 1:1" },
      { canonicalRef: "GEN 1:2" },
      { canonicalRef: null },
      { canonicalRef: "GEN 1:3" },
    ]

    expect(before.map(label)).toEqual(["1", "2", "3"])
    expect(after.map(label)).toEqual(["1", "2", null, "3"])
  })

  it("keeps a manifest displayLabel unchanged when a cell is inserted above it", () => {
    // A DOCX/USFM import owns its own presentation identity, so its label is
    // position-independent by construction — the row index moves, the label
    // does not.
    const cell = { canonicalRef: null, displayLabel: "12" }
    expect(cellNumberLabel({ lineNumbersEnabled: true, cellType: "text", scriptureNumbering: false, rowIndex: 11, ...cell }))
      .toBe("12")
    expect(cellNumberLabel({ lineNumbersEnabled: true, cellType: "text", scriptureNumbering: false, rowIndex: 12, ...cell }))
      .toBe("12")
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

  it("keeps headings unnumbered in ordinary non-scripture files", () => {
    expect(cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: "heading",
      canonicalRef: null,
      scriptureNumbering: false,
      rowIndex: 0,
    })).toBeNull()
  })

  it("honors normalized display labels independently from storage order", () => {
    expect(cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: "cue",
      canonicalRef: null,
      scriptureNumbering: false,
      rowIndex: 98,
      displayLabel: "13",
    })).toBe("13")
    expect(cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: "text",
      canonicalRef: null,
      scriptureNumbering: false,
      rowIndex: 4,
      displayLabel: null,
    })).toBeNull()
  })

  it("reads only a valid normalized display label envelope", () => {
    expect(importDisplayLabel({ aquillaImport: { displayLabel: null } })).toBeNull()
    expect(importDisplayLabel({ aquillaImport: { displayLabel: "31" } })).toBe("31")
    expect(importDisplayLabel({ aquillaImport: { displayLabel: 31 } })).toBeUndefined()
    expect(importDisplayLabel({ unrelated: true })).toBeUndefined()
  })

  it("prefers contentNumber over the raw row index for sequential numbering (AQU-610)", () => {
    // The first real content cell sits at display row 3 (behind front matter),
    // but its content ordinal is 1 — numbering starts at the first content cell.
    expect(cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: "text",
      canonicalRef: null,
      scriptureNumbering: false,
      rowIndex: 3,
      contentNumber: 1,
    })).toBe("1")
  })

  it("numbers non-scripture content from 1, skipping front matter / paratext (AQU-610)", () => {
    // Mirrors how EditorTable feeds contentNumber: a 1-based ordinal counted
    // only over numbered (non-paratext) cells, in display order.
    const rows = [
      { cellType: "paratext", canonicalRef: null }, // USFM front matter
      { cellType: "paratext", canonicalRef: null }, // introduction
      { cellType: "heading", canonicalRef: null },  // structural section heading
      { cellType: "text", canonicalRef: null },     // first real content
      { cellType: "paratext", canonicalRef: null }, // interspersed paratext
      { cellType: "text", canonicalRef: null },
    ]

    let ordinal = 0
    const labels = rows.map((row, rowIndex) => cellNumberLabel({
      lineNumbersEnabled: true,
      scriptureNumbering: false,
      rowIndex,
      contentNumber: row.cellType === "paratext" || row.cellType === "heading" ? undefined : ++ordinal,
      ...row,
    }))

    // Front matter/paratext stay unnumbered; content is gap-free from 1.
    expect(labels).toEqual([null, null, null, "1", null, "2"])
  })
})
