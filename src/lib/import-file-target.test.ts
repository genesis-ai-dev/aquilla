import { describe, it, expect } from "vitest"
import {
  matchTargetRowsByRef,
  matchTargetRowsByOrder,
  usfmToTargetRows,
  type FileTargetCellRef,
} from "./import-file-target"

function cell(overrides: Partial<FileTargetCellRef> & { cellId: string }): FileTargetCellRef {
  return {
    fileId: "file-1",
    translated: "",
    original: `source for ${overrides.cellId}`,
    sourceEventId: `src-evt-${overrides.cellId}`,
    canonicalRef: null,
    ...overrides,
  }
}

describe("matchTargetRowsByRef", () => {
  const cells: FileTargetCellRef[] = [
    cell({ cellId: "c1", canonicalRef: "GEN 1:1" }),
    cell({ cellId: "c2", canonicalRef: "GEN 1:2", translated: "existing", targetEventId: "tgt-evt-c2" }),
    cell({ cellId: "c3", canonicalRef: "GEN 1:3" }),
  ]

  it("matches rows to cells by canonical ref and chains AD-2 parentId correctly", () => {
    const result = matchTargetRowsByRef(
      [
        { ref: "GEN 1:1", text: "In the beginning" },
        { ref: "GEN 1:2", text: "And the earth" },
      ],
      cells,
    )
    expect(result.matched).toHaveLength(2)
    // Genesis target commit chains off the source cell's event id…
    expect(result.matched[0]).toMatchObject({
      cellId: "c1", parentId: "src-evt-c1", hasConflict: false, sourceText: "source for c1",
    })
    // …but an existing target row chains off its own head, and is a conflict.
    expect(result.matched[1]).toMatchObject({
      cellId: "c2", parentId: "tgt-evt-c2", hasConflict: true, currentText: "existing",
    })
    expect(result.unmatchedSourceCount).toBe(1)
  })

  it("treats unknown refs as orphans, never silent drops", () => {
    const result = matchTargetRowsByRef([{ ref: "EXO 1:1", text: "orphan" }], cells)
    expect(result.matched).toHaveLength(0)
    expect(result.orphans).toEqual([{ ref: "EXO 1:1", text: "orphan" }])
  })

  it("ignores rows with empty text so blanks never clear an existing translation", () => {
    const result = matchTargetRowsByRef([{ ref: "GEN 1:2", text: "   " }], cells)
    expect(result.matched).toHaveLength(0)
    expect(result.orphans).toHaveLength(0)
  })

  it("orphans a duplicate ref instead of overwriting the earlier row", () => {
    const result = matchTargetRowsByRef(
      [
        { ref: "GEN 1:1", text: "first wins" },
        { ref: "GEN 1:1", text: "second loses" },
      ],
      cells,
    )
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].incomingText).toBe("first wins")
    expect(result.orphans).toEqual([{ ref: "GEN 1:1", text: "second loses" }])
  })
})

describe("matchTargetRowsByOrder", () => {
  const cells: FileTargetCellRef[] = [
    cell({ cellId: "c1", canonicalRef: "GEN 1:1" }),
    cell({ cellId: "c2" }),
    cell({ cellId: "c3", translated: "existing" }),
  ]

  it("matches row N to cell N", () => {
    const result = matchTargetRowsByOrder(
      [{ text: "row one" }, { text: "row two" }, { text: "row three" }],
      cells,
    )
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c1", "row one"],
      ["c2", "row two"],
      ["c3", "row three"],
    ])
    expect(result.matched[2].hasConflict).toBe(true)
    expect(result.unmatchedSourceCount).toBe(0)
  })

  it("keeps positional alignment across empty rows — empty row consumes its slot", () => {
    const result = matchTargetRowsByOrder(
      [{ text: "row one" }, { text: "" }, { text: "row three" }],
      cells,
    )
    // Row 3 must land on cell 3, not slide up to cell 2.
    expect(result.matched.map((m) => m.cellId)).toEqual(["c1", "c3"])
    expect(result.unmatchedSourceCount).toBe(1)
  })

  it("rows beyond the file's cells become orphans", () => {
    const result = matchTargetRowsByOrder(
      [{ text: "1" }, { text: "2" }, { text: "3" }, { text: "overflow" }],
      cells,
    )
    expect(result.matched).toHaveLength(3)
    expect(result.orphans).toEqual([{ ref: "Row 4", text: "overflow" }])
  })
})

describe("usfmToTargetRows", () => {
  it("extracts verses and headings with the same refs the source import produces", () => {
    const usfm = [
      "\\id MAT",
      "\\mt1 Matthew",
      "\\c 1",
      "\\s1 The Genealogy",
      "\\p",
      "\\v 1 The book of the genealogy.",
      "\\v 2 Abraham fathered Isaac.",
    ].join("\n")
    const rows = usfmToTargetRows(usfm)
    const byRef = new Map(rows.map((r) => [r.ref, r.text]))
    expect(byRef.get("MAT 1:1")).toBe("The book of the genealogy.")
    expect(byRef.get("MAT 1:2")).toBe("Abraham fathered Isaac.")
    // Headings/titles carry their synthetic refs so they can match heading cells.
    const refs = rows.map((r) => r.ref)
    expect(refs.some((r) => r?.includes("mt1"))).toBe(true)
    expect(refs.some((r) => r?.includes(":s"))).toBe(true)
  })

  it("AQU-634: excludeFrontMatter drops the \\mt1 title row but keeps section headings", () => {
    const usfm = [
      "\\id MAT",
      "\\mt1 Matthew",
      "\\c 1",
      "\\s1 The Genealogy",
      "\\p",
      "\\v 1 The book of the genealogy.",
    ].join("\n")
    const rows = usfmToTargetRows(usfm, { excludeFrontMatter: true })
    const refs = rows.map((r) => r.ref)
    // Title front matter is gone…
    expect(refs.some((r) => r?.includes("mt1"))).toBe(false)
    // …but the in-body section heading + verse remain, so target rows stay
    // aligned with source cells imported under the same setting.
    expect(refs.some((r) => r?.includes(":s"))).toBe(true)
    expect(refs).toContain("MAT 1:1")
  })
})
