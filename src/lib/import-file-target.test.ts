import { describe, it, expect } from "vitest"
import {
  matchTargetRowsByRef,
  matchTargetRowsByOrder,
  usfmToTargetRows,
  type FileTargetCellRef,
  type TargetRow,
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

// AQU-1143 — cue files align by timecode overlap, not raw row order.
describe("matchTargetRowsByOrder — cue timecode overlap", () => {
  /** Cue N runs [N s, N s + 800 ms), the shape of a real subtitle grid. */
  function cueCell(n: number, overrides: Partial<FileTargetCellRef> = {}): FileTargetCellRef {
    return cell({
      cellId: `c${n}`,
      startMs: n * 1000,
      endMs: n * 1000 + 800,
      original: `source cue ${n}`,
      ...overrides,
    })
  }
  /** Incoming row carrying explicit cue timings. */
  function cueRow(startMs: number, endMs: number, text: string): TargetRow {
    return { ref: `cue ${startMs}`, startMs, endMs, text }
  }

  const cells = [cueCell(1), cueCell(2), cueCell(3), cueCell(4)]

  it("survives a cue deleted mid-file — later cues keep their own cells", () => {
    // Target is the source grid minus cue 2. Under raw order matching, "three"
    // would land on cell c2 and "four" on c3 — every row after the deletion
    // silently wrong.
    const result = matchTargetRowsByOrder(
      [
        cueRow(1000, 1800, "one"),
        cueRow(3000, 3800, "three"),
        cueRow(4000, 4800, "four"),
      ],
      cells,
    )
    expect(result.alignedBy).toBe("overlap")
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c1", "one"],
      ["c3", "three"],
      ["c4", "four"],
    ])
    // The deleted cue's slot shows up as an uncovered cell, not a bad commit.
    expect(result.unmatchedSourceCount).toBe(1)
    expect(result.orphans).toHaveLength(0)
  })

  it("an inserted extra cue becomes an orphan and displaces nothing", () => {
    const result = matchTargetRowsByOrder(
      [
        cueRow(1000, 1800, "one"),
        cueRow(1850, 1950, "inserted"),
        cueRow(2000, 2800, "two"),
        cueRow(3000, 3800, "three"),
      ],
      cells,
    )
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c1", "one"],
      ["c2", "two"],
      ["c3", "three"],
    ])
    expect(result.orphans.map((o) => o.text)).toEqual(["inserted"])
  })

  it("sub-second drift still matches the counterpart cue", () => {
    const result = matchTargetRowsByOrder(
      [cueRow(1300, 2100, "one"), cueRow(2300, 3100, "two")],
      cells,
    )
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c1", "one"],
      ["c2", "two"],
    ])
  })

  it("a cue beyond tolerance of every cell is an orphan, never a wrong-cell commit", () => {
    const result = matchTargetRowsByOrder([cueRow(60000, 60800, "way out")], cells)
    expect(result.matched).toHaveLength(0)
    expect(result.orphans).toEqual([{ ref: "cue 60000", text: "way out" }])
    expect(result.unmatchedSourceCount).toBe(4)
  })

  it("recovers timings from a VTT cue timecode label when none are passed", () => {
    // The VTT target import labels each row with its cue range; that label is
    // enough to align by, so callers need not restate the timings.
    const result = matchTargetRowsByOrder(
      [
        { ref: "00:00:03.000 --> 00:00:03.800", text: "three" },
        { ref: "00:00:01.000 --> 00:00:01.800", text: "one" },
      ],
      cells,
    )
    expect(result.alignedBy).toBe("overlap")
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c3", "three"],
      ["c1", "one"],
    ])
    // Rows are listed in the incoming file's order, labelled by timecode.
    expect(result.matched[0].ref).toBe("00:00:03.000 --> 00:00:03.800")
  })

  it("an empty incoming cue commits nothing and frees no cell for its neighbour", () => {
    const result = matchTargetRowsByOrder(
      [cueRow(1000, 1800, "one"), cueRow(2000, 2800, "   "), cueRow(3000, 3800, "three")],
      cells,
    )
    expect(result.matched.map((m) => m.cellId)).toEqual(["c1", "c3"])
    expect(result.unmatchedSourceCount).toBe(2)
  })

  it("falls back to raw order when the file's cells carry no timings", () => {
    const untimed = [cell({ cellId: "u1" }), cell({ cellId: "u2" })]
    const result = matchTargetRowsByOrder(
      [cueRow(1000, 1800, "one"), cueRow(2000, 2800, "two")],
      untimed,
    )
    expect(result.alignedBy).toBe("order")
    expect(result.matched.map((m) => m.cellId)).toEqual(["u1", "u2"])
  })

  it("falls back to raw order when an incoming row carries no timing", () => {
    const result = matchTargetRowsByOrder(
      [cueRow(1000, 1800, "one"), { text: "no timing here" }],
      cells,
    )
    expect(result.alignedBy).toBe("order")
    expect(result.matched.map((m) => m.cellId)).toEqual(["c1", "c2"])
  })

  it("spreadsheet order matching is untouched — no timings on either side", () => {
    const untimed = [cell({ cellId: "s1" }), cell({ cellId: "s2" }), cell({ cellId: "s3" })]
    const result = matchTargetRowsByOrder(
      [{ text: "one" }, { text: "" }, { text: "three" }],
      untimed,
    )
    expect(result.alignedBy).toBe("order")
    expect(result.matched.map((m) => m.cellId)).toEqual(["s1", "s3"])
    expect(result.unmatchedSourceCount).toBe(1)
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
