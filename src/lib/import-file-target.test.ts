import { describe, it, expect } from "vitest"
import {
  matchTargetRowsByRef,
  matchTargetRowsByOrder,
  matchTargetRowsByOverlap,
  usfmToTargetRows,
  subtitleToTargetRows,
  subtitleToTargetRowsWithReport,
  vttToTargetRows,
  vttToTargetRowsWithReport,
  toFileTargetCells,
  type FileTargetCellRef,
  type FileTargetCellSource,
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

  it("AQU-1144: labels the row with the incoming row's own ref when it carries one", () => {
    const result = matchTargetRowsByOrder(
      [
        { ref: "00:00:01,000 --> 00:00:04,000", text: "cue one" },
        { ref: "00:00:05,000 --> 00:00:07,000", text: "cue two" },
      ],
      cells,
    )
    // A cue row's timecode wins over the matched cell's canonicalRef — the
    // cell's ref is meaningless for cue files and absent for most of them.
    expect(result.matched.map((m) => m.ref)).toEqual([
      "00:00:01,000 --> 00:00:04,000",
      "00:00:05,000 --> 00:00:07,000",
    ])
  })

  it("AQU-1144: rows with no ref still fall back to the cell ref then the row number", () => {
    const result = matchTargetRowsByOrder([{ text: "a" }, { text: "b" }], cells)
    // Spreadsheet-by-order rows carry no ref, so their labels are unchanged.
    expect(result.matched.map((m) => m.ref)).toEqual(["GEN 1:1", "Row 2"])
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
    expect(result.orphans).toEqual([{ ref: "cue 60000", text: "way out", reason: "noLineInReach" }])
    expect(result.unmatchedSourceCount).toBe(4)
  })

  // AQU-1360: a broken timecode is named, and doesn't drag the file down.
  it("names a cue whose timecode ends before it starts, from its fields or its label", () => {
    const result = matchTargetRowsByOrder(
      [
        cueRow(1000, 1800, "one"),
        cueRow(3000, 2000, "backwards by field"),
        { ref: "00:00:04.800 --> 00:00:04.000", text: "backwards by label" },
      ],
      cells,
    )
    expect(result.orphans).toEqual([
      { ref: "cue 3000", text: "backwards by field", reason: "backwardsTimecode" },
      { ref: "00:00:04.800 --> 00:00:04.000", text: "backwards by label", reason: "backwardsTimecode" },
    ])
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([["c1", "one"]])
  })

  it("a broken timecode doesn't knock the rest of the file back to matching by position", () => {
    // Before AQU-1360 one unplaceable cue would have been read as "this row has
    // no timing", flipping every other row to row-N-to-cell-N.
    const result = matchTargetRowsByOrder(
      [cueRow(3000, 2000, "broken"), cueRow(3000, 3800, "three"), cueRow(4000, 4800, "four")],
      cells,
    )
    expect(result.alignedBy).toBe("overlap")
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c3", "three"],
      ["c4", "four"],
    ])
  })

  it("lists the lines left without a translation by name, in display order", () => {
    const named = [
      cueCell(1, { cueRef: "00:00:01.000 --> 00:00:01.800" }),
      cueCell(2, { cueRef: "00:00:02.000 --> 00:00:02.800" }),
      cueCell(3, { cueRef: "00:00:03.000 --> 00:00:03.800" }),
    ]
    const result = matchTargetRowsByOrder([cueRow(2000, 2800, "two")], named)
    expect(result.uncovered).toEqual([
      { cellId: "c1", sourceText: "source cue 1", cellRef: "00:00:01.000 --> 00:00:01.800" },
      { cellId: "c3", sourceText: "source cue 3", cellRef: "00:00:03.000 --> 00:00:03.800" },
    ])
    expect(result.unmatchedSourceCount).toBe(2)
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

describe("subtitleToTargetRowsWithReport (AQU-1360)", () => {
  it("counts an empty SRT cue as skipped rather than letting it vanish", () => {
    const srt = [
      "1", "00:00:01,000 --> 00:00:02,000", "one", "",
      "2", "00:00:03,000 --> 00:00:04,000", "", "",
      "3", "00:00:05,000 --> 00:00:06,000", "three", "",
    ].join("\n")
    const { rows, skippedCues } = subtitleToTargetRowsWithReport(srt, "srt")
    expect(rows.map((r) => r.text)).toEqual(["one", "three"])
    expect(skippedCues).toBe(1)
  })

  it("counts an SBV block with no text as skipped", () => {
    const sbv = ["0:00:01.000,0:00:02.000", "one", "", "0:00:03.000,0:00:04.000", "", "0:00:05.000,0:00:06.000", "three"].join("\n")
    expect(subtitleToTargetRowsWithReport(sbv, "sbv").skippedCues).toBe(1)
  })
})

describe("subtitleToTargetRows (AQU-1144)", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:04,000",
    "Bilong wanem yu kam?",
    "",
    "2",
    "00:00:05,500 --> 00:00:08,250",
    "Mi kam long lukim yu,",
    "na long harim tok bilong yu.",
    "",
    "3",
    "00:00:09,000 --> 00:00:11,000",
    "Orait.",
    "",
  ].join("\n")

  it("extracts one row per SRT cue, labelled with the cue's timecode range", () => {
    const rows = subtitleToTargetRows(srt, "srt")
    expect(rows).toEqual([
      { ref: "00:00:01,000 --> 00:00:04,000", text: "Bilong wanem yu kam?", startMs: 1000, endMs: 4000 },
      {
        ref: "00:00:05,500 --> 00:00:08,250",
        text: "Mi kam long lukim yu,\nna long harim tok bilong yu.",
        startMs: 5500,
        endMs: 8250,
      },
      { ref: "00:00:09,000 --> 00:00:11,000", text: "Orait.", startMs: 9000, endMs: 11000 },
    ])
  })

  it("never leaks SRT numeric cue counters or blank separators into the text", () => {
    const rows = subtitleToTargetRows(srt, "srt")
    for (const row of rows) {
      expect(row.text).not.toMatch(/^\d+$/m)
      expect(row.text.trim()).toBe(row.text)
    }
  })

  it("extracts one row per SBV cue, labelled with the cue's timecode line", () => {
    const sbv = [
      "0:00:01.000,0:00:04.000",
      "Bilong wanem yu kam?",
      "",
      "0:00:05.500,0:00:08.250",
      "Mi kam long lukim yu,",
      "na long harim tok bilong yu.",
      "",
    ].join("\n")
    expect(subtitleToTargetRows(sbv, "sbv")).toEqual([
      { ref: "0:00:01.000,0:00:04.000", text: "Bilong wanem yu kam?", startMs: 1000, endMs: 4000 },
      {
        ref: "0:00:05.500,0:00:08.250",
        text: "Mi kam long lukim yu,\nna long harim tok bilong yu.",
        startMs: 5500,
        endMs: 8250,
      },
    ])
  })

  it("SBV cues align by timecode overlap (AQU-1143) — their label has no `-->` to recover timings from", () => {
    // Source grid has three cues; the incoming SBV drops the middle one. Raw
    // order would put "three" on c2.
    const sbv = [
      "0:00:01.000,0:00:01.800",
      "one",
      "",
      "0:00:03.000,0:00:03.800",
      "three",
      "",
    ].join("\n")
    const timedCells: FileTargetCellRef[] = [
      cell({ cellId: "c1", startMs: 1000, endMs: 1800 }),
      cell({ cellId: "c2", startMs: 2000, endMs: 2800 }),
      cell({ cellId: "c3", startMs: 3000, endMs: 3800 }),
    ]
    const result = matchTargetRowsByOrder(subtitleToTargetRows(sbv, "sbv"), timedCells)
    expect(result.alignedBy).toBe("overlap")
    expect(result.matched.map((m) => [m.cellId, m.incomingText, m.ref])).toEqual([
      ["c1", "one", "0:00:01.000,0:00:01.800"],
      ["c3", "three", "0:00:03.000,0:00:03.800"],
    ])
    expect(result.unmatchedSourceCount).toBe(1)
  })

  it("returns no rows for a file with no parseable cues, so the panel can say so", () => {
    expect(subtitleToTargetRows("not a subtitle file at all\n", "srt")).toEqual([])
    expect(subtitleToTargetRows("not a subtitle file at all\n", "sbv")).toEqual([])
  })

  it("feeds matchTargetRowsByOrder so cue N lands on cell N with its timecode label", () => {
    const cells: FileTargetCellRef[] = [
      cell({ cellId: "c1" }),
      cell({ cellId: "c2" }),
      cell({ cellId: "c3", translated: "already translated", targetEventId: "tgt-evt-c3" }),
    ]
    const result = matchTargetRowsByOrder(subtitleToTargetRows(srt, "srt"), cells)
    expect(result.matched.map((m) => [m.cellId, m.ref])).toEqual([
      ["c1", "00:00:01,000 --> 00:00:04,000"],
      ["c2", "00:00:05,500 --> 00:00:08,250"],
      ["c3", "00:00:09,000 --> 00:00:11,000"],
    ])
    // A cell that already holds a translation is a conflict, so the panel
    // leaves it unticked rather than silently overwriting it.
    expect(result.matched[2].hasConflict).toBe(true)
    expect(result.unmatchedSourceCount).toBe(0)
  })
})

// The editor hands cells over with cue timings in SECONDS; every matcher input
// is milliseconds. Passing the seconds through unconverted made a subtitle
// target import match 0 rows on a real cue file (PR #530 QA walk).
describe("toFileTargetCells", () => {
  /** Editor cell summaries for a four-cue file, timed as the cell view times
   *  them — fractional seconds. */
  const summaries: FileTargetCellSource[] = [
    { id: "c1", fileId: "f1", original: "one", group: "uuid-1", startTime: 1, endTime: 3 },
    { id: "c2", fileId: "f1", original: "two", group: "uuid-2", startTime: 3.5, endTime: 5.5 },
    { id: "c3", fileId: "f1", original: "three", group: "uuid-3", startTime: 6, endTime: 8 },
    { id: "c4", fileId: "f1", original: "four", group: "uuid-4", startTime: 8.5, endTime: 10 },
  ]

  it("converts cue timings from seconds to integer milliseconds", () => {
    expect(toFileTargetCells(summaries).map((c) => [c.startMs, c.endMs])).toEqual([
      [1000, 3000],
      [3500, 5500],
      [6000, 8000],
      [8500, 10000],
    ])
  })

  it("carries the fields the matchers and the review screen read", () => {
    const [first] = toFileTargetCells([
      { ...summaries[0], translated: "uno", targetEventId: "t1", sourceEventId: "s1" },
    ])
    expect(first).toEqual({
      cellId: "c1",
      fileId: "f1",
      targetEventId: "t1",
      sourceEventId: "s1",
      translated: "uno",
      canonicalRef: "uuid-1",
      original: "one",
      startMs: 1000,
      endMs: 3000,
    })
  })

  it("carries the line's own timecode label for the review screen, and none for an untimed line", () => {
    const [timed, untimed] = toFileTargetCells([
      { ...summaries[0], context: "00:00:01.000 --> 00:00:03.000" },
      { id: "v1", fileId: "f1", original: "In the beginning", group: "GEN 1:1", context: "" },
    ])
    expect(timed.cueRef).toBe("00:00:01.000 --> 00:00:03.000")
    expect(untimed).not.toHaveProperty("cueRef")
  })

  it("leaves untimed cells untimed, so they keep order matching", () => {
    const [untimed] = toFileTargetCells([{ id: "v1", fileId: "f1", original: "In the beginning", group: "GEN 1:1" }])
    expect(untimed.startMs).toBeUndefined()
    expect(untimed.endMs).toBeUndefined()
    expect(untimed.translated).toBe("")
  })

  const srt = [
    "1", "00:00:01,000 --> 00:00:03,000", "wan", "",
    "2", "00:00:03,500 --> 00:00:05,500", "tu", "",
    "3", "00:00:06,000 --> 00:00:08,000", "tri", "",
    "4", "00:00:08,500 --> 00:00:10,000", "foa", "",
  ].join("\n")
  const sbv = [
    "0:00:01.000,0:00:03.000", "wan", "",
    "0:00:03.500,0:00:05.500", "tu", "",
    "0:00:06.000,0:00:08.000", "tri", "",
    "0:00:08.500,0:00:10.000", "foa", "",
  ].join("\n")
  const vtt = [
    "WEBVTT", "",
    "00:00:01.000 --> 00:00:03.000", "wan", "",
    "00:00:03.500 --> 00:00:05.500", "tu", "",
    "00:00:06.000 --> 00:00:08.000", "tri", "",
    "00:00:08.500 --> 00:00:10.000", "foa", "",
  ].join("\n")

  it.each([
    ["srt", () => subtitleToTargetRows(srt, "srt")],
    ["sbv", () => subtitleToTargetRows(sbv, "sbv")],
    ["vtt", () => vttToTargetRows(vtt)],
  ])("a translated .%s of the same episode matches every cue of the open file", (_ext, rows) => {
    const result = matchTargetRowsByOrder(rows(), toFileTargetCells(summaries))
    expect(result.alignedBy).toBe("overlap")
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c1", "wan"],
      ["c2", "tu"],
      ["c3", "tri"],
      ["c4", "foa"],
    ])
    expect(result.orphans).toHaveLength(0)
    expect(result.unmatchedSourceCount).toBe(0)
  })
})

// AQU-1142: WebVTT subtitle target import. Cues carry timestamps, not canonical
// refs — matching is positional (cue N → cell N) and the row's `ref` field
// carries the timestamp so the review screen labels rows by timecode.
describe("vttToTargetRows", () => {
  it("returns one row per cue, ref = timestamp, text = cue body", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Hello world",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "Second cue",
    ].join("\n")
    expect(vttToTargetRows(vtt)).toEqual([
      { ref: "00:00:01.000 --> 00:00:04.000", text: "Hello world", startMs: 1000, endMs: 4000 },
      { ref: "00:00:05.000 --> 00:00:08.000", text: "Second cue", startMs: 5000, endMs: 8000 },
    ])
  })

  it("counts the cues that never became rows: empty ones, and ones whose text decodes to nothing", () => {
    const vtt = [
      "WEBVTT", "",
      "00:00:01.000 --> 00:00:02.000", "kept", "",
      "00:00:03.000 --> 00:00:04.000", "",
      "00:00:05.000 --> 00:00:06.000", "&nbsp;", "",
      "00:00:07.000 --> 00:00:08.000", "also kept",
    ].join("\n")
    const { rows, skippedCues } = vttToTargetRowsWithReport(vtt)
    expect(rows.filter((r) => r.text).map((r) => r.text)).toEqual(["kept", "also kept"])
    expect(skippedCues).toBe(2)
  })

  it("reports no skipped cues for a clean file", () => {
    const vtt = ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "one"].join("\n")
    expect(vttToTargetRowsWithReport(vtt).skippedCues).toBe(0)
  })

  it("joins multi-line cues into a single row so cell N still lands on cue N", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Line one",
      "Line two",
    ].join("\n")
    const rows = vttToTargetRows(vtt)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe("Line one\nLine two")
  })

  it("decodes &nbsp; and other common entities so they don't show up literally in the target column", () => {
    // Partner sample (TheChosen_101_tpi.vtt) carries &nbsp; between short line
    // continuations — showing that raw in the editor is a visible defect.
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Hello&nbsp;world &amp; friends",
    ].join("\n")
    expect(vttToTargetRows(vtt)[0].text).toBe("Hello world & friends")
  })

  it("skips WEBVTT header, numeric cue identifiers, and NOTE blocks", () => {
    // The parser must never leak protocol lines into the translation. Every
    // non-cue line here would land in the target column if the guard failed.
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "NOTE This block is a comment",
      "and continues across lines.",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Real translation",
    ].join("\n")
    const rows = vttToTargetRows(vtt)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe("Real translation")
  })

  it("preserves cue order even when the file's timestamps run out of order (partner sample)", () => {
    // TheChosen_101_tpi.vtt has out-of-order timestamps at a handful of cues;
    // positional matching means we care about the order rows arrive in, not
    // whether their timestamps monotonically increase.
    const vtt = [
      "WEBVTT",
      "",
      "00:00:10.000 --> 00:00:12.000",
      "cue 1",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "cue 2 (earlier timestamp)",
      "",
      "00:00:15.000 --> 00:00:18.000",
      "cue 3",
    ].join("\n")
    expect(vttToTargetRows(vtt).map((r) => r.text)).toEqual([
      "cue 1",
      "cue 2 (earlier timestamp)",
      "cue 3",
    ])
  })

  it("returns an empty array for a header-only file so the panel can show its no-cues error", () => {
    expect(vttToTargetRows("WEBVTT\n")).toEqual([])
  })
  it("keeps a short-form cue instead of losing it with its words", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "01:03.209 --> 01:03.667",
      "Abba?",
      "",
      "2",
      "00:01:06.626 --> 00:01:07.751",
      "You should be sleeping, little one.",
    ].join("\n")
    expect(vttToTargetRows(vtt)).toEqual([
      { ref: "00:01:03.209 --> 00:01:03.667", text: "Abba?", startMs: 63209, endMs: 63667 },
      {
        ref: "00:01:06.626 --> 00:01:07.751",
        text: "You should be sleeping, little one.",
        startMs: 66626,
        endMs: 67751,
      },
    ])
  })

  it("a short-form cue mid-file leaves every later cue on its own cell", () => {
    // The alignment consequence, which is what actually bites: a cue the
    // parser refuses is not a blank row, it is one FEWER row — so every later
    // translation slides up one cell, and on a 500-row review screen the only
    // tell is mismatched source text.
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "first",
      "",
      "1:03.209 --> 1:03.667",
      "second",
      "",
      "00:02:00.000 --> 00:02:01.000",
      "third",
    ].join("\n")
    const result = matchTargetRowsByOrder(vttToTargetRows(vtt), [
      cell({ cellId: "c1" }),
      cell({ cellId: "c2" }),
      cell({ cellId: "c3" }),
    ])
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["c1", "first"],
      ["c2", "second"],
      ["c3", "third"],
    ])
    expect(result.unmatchedSourceCount).toBe(0)
  })

})

describe("frame-rate rescale (AQU-1360)", () => {
  /** A deterministic but irregular episode — cue lengths 0.8–3s, gaps
   *  0.08–1.5s — like a real subtitle grid. A perfectly regular grid would let
   *  a wrong scale line up by aliasing and prove nothing. */
  function episode(count: number, seed = 7): FileTargetCellRef[] {
    let s = seed
    const rand = () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
    const cells: FileTargetCellRef[] = []
    let t = 5000
    for (let i = 0; i < count; i++) {
      const dur = 800 + Math.round(rand() * 2200)
      cells.push(cell({ cellId: `c${i}`, startMs: t, endMs: t + dur, original: `line ${i}` }))
      t += dur + 80 + Math.round(rand() * 1420)
    }
    return cells
  }

  /** The same episode as a partner would deliver it, every time mapped by `f`. */
  function delivered(cells: FileTargetCellRef[], f: (ms: number) => number): TargetRow[] {
    return cells.map((c, i) => ({
      ref: `cue ${i}`,
      text: `target ${i}`,
      startMs: Math.round(f(c.startMs!)),
      endMs: Math.round(f(c.endMs!)),
    }))
  }

  /** Rows that landed on the line they were written for. */
  function correct(result: ReturnType<typeof matchTargetRowsByOrder>): number {
    return result.matched.filter((m) => m.cellId === `c${m.incomingText.slice("target ".length)}`).length
  }

  const PAL = 25 / (24000 / 1001) // 25 fps against 23.976

  it("leaves a correctly timed file exactly as delivered", () => {
    const cells = episode(650)
    const result = matchTargetRowsByOrder(delivered(cells, (t) => t), cells)
    expect(result.timebase).toBeUndefined()
    expect(result.offsetCorrection).toBeUndefined()
    expect(correct(result)).toBe(650)
  })

  it("at 25 against 23.976 a real-length episode mis-pairs silently — and the rescale recovers every line", () => {
    const cells = episode(650)
    const rows = delivered(cells, (t) => t / PAL)
    // What the matcher did before AQU-1360: most rows "match", almost none
    // correctly. This is the failure the review screen used to hide.
    const unscaled = matchTargetRowsByOverlap(rows, cells)
    expect(unscaled.matched.length).toBeGreaterThan(300)
    expect(correct(unscaled)).toBeLessThan(100)

    const result = matchTargetRowsByOrder(rows, cells)
    expect(result.timebase?.scale).toBeCloseTo(PAL, 9)
    expect(result.timebase).toMatchObject({ fromFps: "25", toFps: "23.976", closeAfter: 650 })
    expect(correct(result)).toBe(650)
    // The label a reviewer sees is still the file's own timecode.
    expect(result.matched[0].ref).toBe("cue 0")
  })

  it("rescales the other direction too", () => {
    const cells = episode(650)
    const result = matchTargetRowsByOrder(delivered(cells, (t) => t * PAL), cells)
    expect(result.timebase?.scale).toBeCloseTo(1 / PAL, 9)
    expect(result.timebase).toMatchObject({ fromFps: "23.976", toFps: "25" })
    expect(correct(result)).toBe(650)
  })

  it("rescales a 1000/1001 drift over a long episode, without naming rates it can't tell apart", () => {
    const cells = episode(1000)
    const result = matchTargetRowsByOrder(delivered(cells, (t) => t / 1.001), cells)
    expect(result.timebase?.scale).toBeCloseTo(1.001, 9)
    // 24/23.976 and 30/29.97 are both exactly 1001/1000.
    expect(result.timebase).toMatchObject({ fromFps: null, toFps: null })
    expect(correct(result)).toBe(1000)
  })

  it.each([
    ["a 2s start offset", (t: number) => t + 2000, -2000],
    ["a 700ms start offset", (t: number) => t + 700, -700],
    ["a -5s start offset", (t: number) => t - 5000, 5000],
    ["a one-hour broadcast offset", (t: number) => t + 3_600_000, -3_600_000],
  ])("shifts %s back into place — never 'fixing' it with a wrong frame rate", (_name, f, expected) => {
    const cells = episode(650)
    const result = matchTargetRowsByOrder(delivered(cells, f), cells)
    expect(result.offsetCorrection?.scale).toBe(1)
    expect(Math.abs(result.offsetCorrection!.offsetMs - expected)).toBeLessThanOrEqual(20)
    // Offered AND applied: the tickbox starts ticked.
    expect(result.timebase).toEqual(result.offsetCorrection)
    expect(correct(result)).toBe(650)
  })

  it("corrects a frame-rate mismatch and a shift together", () => {
    const cells = episode(650)
    const result = matchTargetRowsByOrder(delivered(cells, (t) => t / PAL + 2000), cells)
    expect(result.offsetCorrection?.scale).toBeCloseTo(PAL, 9)
    expect(result.offsetCorrection).toMatchObject({ fromFps: "25", toFps: "23.976" })
    expect(Math.abs(result.offsetCorrection!.offsetMs + 2000 * PAL)).toBeLessThanOrEqual(20)
    expect(correct(result)).toBe(650)
  })

  it("unticked, leaves the shift unapplied but still offers it", () => {
    const cells = episode(650)
    const rows = delivered(cells, (t) => t + 2000)
    const ticked = matchTargetRowsByOrder(rows, cells)
    const unticked = matchTargetRowsByOrder(rows, cells, { applyOffset: false })
    expect(unticked.timebase).toBeUndefined()
    expect(unticked.offsetCorrection).toEqual(ticked.offsetCorrection)
    expect(correct(unticked)).toBeLessThan(100)
    expect(unticked.looseFit).toBe(true)
  })

  it("unticked, still applies a frame-rate correction that stands on its own", () => {
    const cells = episode(650)
    const unticked = matchTargetRowsByOrder(delivered(cells, (t) => t / PAL + 2000), cells, { applyOffset: false })
    // The stretch alone can't line this file up (every quarter must fit), so nothing applies.
    expect(unticked.timebase).toBeUndefined()
    // A pure frame-rate file never offers a shift at all.
    const pure = matchTargetRowsByOrder(delivered(cells, (t) => t / PAL), cells)
    expect(pure.offsetCorrection).toBeUndefined()
    expect(pure.timebase?.offsetMs).toBe(0)
  })

  it("shifts a short file's broadcast hour — a frame rate that lands every cue in the same place is not a rival", () => {
    // Over a one-minute file, "one hour" and "one hour plus 3.6s at 1.001"
    // put every cue within a few ms of each other. They are one answer.
    const cells = episode(30)
    const result = matchTargetRowsByOrder(delivered(cells, (t) => t + 3_600_000), cells)
    expect(result.offsetCorrection).toMatchObject({ scale: 1, offsetMs: -3_600_000 })
    expect(correct(result)).toBe(30)
  })

  it("refuses to choose between two equally good shifts on a regular grid", () => {
    // Every line 1s long, every 2s. A file half a spacing late fits the true
    // shift and the one-line-over shift equally well: it can't be told which.
    const grid = Array.from({ length: 100 }, (_, i) =>
      cell({ cellId: `c${i}`, startMs: 10_000 + i * 2000, endMs: 11_000 + i * 2000 }))
    const result = matchTargetRowsByOrder(delivered(grid, (t) => t + 1000), grid)
    expect(result.offsetCorrection).toBeUndefined()
    expect(result.timebase).toBeUndefined()
  })

  it("declines a re-segmented file, where the translator split lines instead of shifting them", () => {
    const cells = episode(650)
    const rows: TargetRow[] = []
    cells.forEach((c, i) => {
      if (i % 5 < 2) {
        const mid = Math.round((c.startMs! + c.endMs!) / 2)
        rows.push({ ref: `a${i}`, text: `target ${i}a`, startMs: c.startMs, endMs: mid })
        rows.push({ ref: `b${i}`, text: `target ${i}b`, startMs: mid, endMs: c.endMs })
      } else {
        rows.push({ ref: `cue ${i}`, text: `target ${i}`, startMs: c.startMs, endMs: c.endMs })
      }
    })
    expect(matchTargetRowsByOrder(rows, cells).timebase).toBeUndefined()
    expect(matchTargetRowsByOrder(rows, cells).offsetCorrection).toBeUndefined()
  })

  it("declines missing and extra cues", () => {
    const cells = episode(650)
    const rows = delivered(cells, (t) => t).filter((_, i) => i % 9 !== 4)
    rows.push({ ref: "extra", text: "target extra", startMs: 99_000_000, endMs: 99_001_000 })
    expect(matchTargetRowsByOrder(rows, cells).timebase).toBeUndefined()
    expect(matchTargetRowsByOrder(rows, cells).offsetCorrection).toBeUndefined()
  })

  it("never rescales or shifts a file too small to judge", () => {
    const cells = episode(19)
    expect(matchTargetRowsByOrder(delivered(cells, (t) => t / PAL), cells).timebase).toBeUndefined()
    expect(matchTargetRowsByOrder(delivered(cells, (t) => t + 2000), cells).offsetCorrection).toBeUndefined()
  })
})

describe("review flags (AQU-1360)", () => {
  const line = (id: string, startMs: number, endMs: number) =>
    cell({ cellId: id, startMs, endMs, original: `SOURCE ${id}` })
  const cue = (text: string, startMs: number, endMs: number): TargetRow => ({
    ref: `${startMs}-${endMs}`,
    text,
    startMs,
    endMs,
  })
  /** Where each cue landed and what the review screen is told about it. */
  function review(rows: TargetRow[], cells: FileTargetCellRef[]) {
    const r = matchTargetRowsByOverlap(rows, cells)
    return {
      pairs: r.matched.map((m) => [m.incomingText, m.cellId, m.flag ?? null]),
      orphans: r.orphans.map((o) => [o.text, o.reason]),
    }
  }

  // The tight grid: line 1 then line 2 a tenth of a second later.
  const tight = [line("L1", 10000, 10400), line("L2", 10500, 10900), line("L3", 20000, 20400)]

  describe("the contested flag fires when two cues fought over one line", () => {
    it("a cue shifted onto its neighbour's slot while the neighbour's own cue is there — flags both", () => {
      expect(review([cue("T1", 10500, 10900), cue("T2", 10500, 10900), cue("T3", 20000, 20400)], tight).pairs)
        .toEqual([["T1", "L2", "contested"], ["T2", "L1", "contested"], ["T3", "L3", null]])
    })

    it("the same swap listed the other way round — still both", () => {
      expect(review([cue("T2", 10500, 10900), cue("T1", 10500, 10900), cue("T3", 20000, 20400)], tight).pairs)
        .toEqual([["T2", "L2", "contested"], ["T1", "L1", "contested"], ["T3", "L3", null]])
    })

    it("a loose swap: the shifted cue lies mostly on the neighbour's slot, not exactly", () => {
      expect(review([cue("T1", 10450, 10850), cue("T2", 10500, 10900), cue("T3", 20000, 20400)], tight).pairs)
        .toEqual([["T1", "L1", "contested"], ["T2", "L2", "contested"], ["T3", "L3", null]])
    })

    const long = [line("L", 10000, 12000), line("N", 12500, 13500)]

    it("a line split into two cues: the half that lost its line is named, the half that kept it is flagged", () => {
      const r = review([cue("half 1", 10000, 11000), cue("half 2", 11000, 12000), cue("next", 12500, 13500)], long)
      expect(r.pairs).toEqual([["half 1", "L", "contested"], ["next", "N", null]])
      expect(r.orphans).toEqual([["half 2", "lostItsLine"]])
    })

    it("a split with a shorter second half", () => {
      const r = review([cue("half 1", 10000, 11200), cue("half 2", 11200, 12000), cue("next", 12500, 13500)], long)
      expect(r.pairs).toEqual([["half 1", "L", "contested"], ["next", "N", null]])
      expect(r.orphans).toEqual([["half 2", "lostItsLine"]])
    })

    it("a split whose second half straddles into the gap before the next line", () => {
      const r = review([cue("half 1", 10000, 11000), cue("half 2", 11000, 12300), cue("next", 12500, 13500)], long)
      expect(r.pairs).toEqual([["half 1", "L", "contested"], ["next", "N", null]])
      expect(r.orphans).toEqual([["half 2", "lostItsLine"]])
    })

    it("both halves inside one line", () => {
      const r = review([cue("half 1", 10200, 11000), cue("half 2", 11000, 11800), cue("next", 12500, 13500)], long)
      expect(r.pairs).toEqual([["half 1", "L", "contested"], ["next", "N", null]])
      expect(r.orphans).toEqual([["half 2", "lostItsLine"]])
    })
  })

  describe("numbering contests, so several in one file can be told apart", () => {
    const cells = [
      line("L1", 10000, 10400), line("L2", 10500, 10900), line("L3", 20000, 20400),
      line("M", 30000, 32000), line("N", 32500, 33500),
    ]
    const swap = [cue("T1", 10450, 10850), cue("T2", 10500, 10900), cue("T3", 20000, 20400)]
    const split = [cue("half 1", 30000, 31000), cue("half 2", 31000, 32000), cue("next", 32500, 33500)]
    const numbered = (rows: TargetRow[]) => {
      const r = matchTargetRowsByOverlap(rows, cells)
      return {
        pairs: r.matched.map((m) => [m.incomingText, m.cellId, m.contest ?? null]),
        orphans: r.orphans.map((o) => [o.text, o.reason, o.contest ?? null]),
      }
    }

    it("gives each contest its own number, in list order, and the cue that lost carries its number too", () => {
      expect(numbered([...swap, ...split])).toEqual({
        pairs: [["T1", "L1", 1], ["T2", "L2", 1], ["T3", "L3", null], ["half 1", "M", 2], ["next", "N", null]],
        orphans: [["half 2", "lostItsLine", 2]],
      })
    })

    it("numbers by where the rows sit in the file, not by time", () => {
      expect(numbered([...split, ...swap])).toEqual({
        pairs: [["half 1", "M", 1], ["next", "N", null], ["T1", "L1", 2], ["T2", "L2", 2], ["T3", "L3", null]],
        orphans: [["half 2", "lostItsLine", 1]],
      })
    })

    it("leaves every row outside a contest unnumbered, including shared-timing rows", () => {
      const speakers = [line("S2", 20000, 21500), line("S3", 20000, 21500)]
      const r = matchTargetRowsByOverlap([cue("PETER", 20000, 21500), cue("ANDREW", 20000, 21500)], speakers)
      expect(r.matched.map((m) => [m.flag ?? null, m.contest ?? null])).toEqual([["sharedTiming", null], ["sharedTiming", null]])
    })
  })

  describe("the contested flag stays silent on every correct or merely imperfect file", () => {
    const three = [line("A", 1000, 1800), line("B", 2000, 2800), line("C", 3000, 3800)]

    it("a correct file whose cues are listed in a different order", () => {
      expect(review([cue("c", 3000, 3800), cue("a", 1000, 1800), cue("b", 2000, 2800)], three).pairs)
        .toEqual([["c", "C", null], ["a", "A", null], ["b", "B", null]])
    })

    it("a uniform 300ms shift", () => {
      expect(review([cue("a", 1300, 2100), cue("b", 2300, 3100), cue("c", 3300, 4100)], three).pairs)
        .toEqual([["a", "A", null], ["b", "B", null], ["c", "C", null]])
    })

    it("a 300ms shift over lines of unequal length (a false alarm under the first rule tried)", () => {
      const cells = [line("short", 10000, 10400), line("long", 10500, 12500)]
      expect(review([cue("s", 10300, 10700), cue("l", 10800, 12800)], cells).pairs)
        .toEqual([["s", "short", null], ["l", "long", null]])
    })

    it("near-simultaneous speakers whose ranges differ (a former false alarm)", () => {
      const cells = [line("A", 10000, 12000), line("B", 10000, 11500)]
      expect(review([cue("x", 10000, 11600), cue("y", 10000, 12000)], cells).pairs)
        .toEqual([["x", "B", null], ["y", "A", null]])
    })

    it("a cue nudged late toward its neighbour (a former false alarm)", () => {
      expect(review([cue("T1", 10350, 10750), cue("T2", 10500, 10900), cue("T3", 20000, 20400)], tight).pairs)
        .toEqual([["T1", "L1", null], ["T2", "L2", null], ["T3", "L3", null]])
    })

    it("a short line slid just clear of its slot (a former false alarm)", () => {
      const cells = [line("short", 10000, 10200), line("next", 11000, 11800)]
      expect(review([cue("s", 10250, 10450), cue("n", 11000, 11800)], cells).pairs)
        .toEqual([["s", "short", null], ["n", "next", null]])
    })

    it("a short cue slid just clear of its slot, beside a long line it grazes", () => {
      // The short cue lies mostly on the long line (150 of its 200ms) but
      // covers a sliver of it, and pairs correctly with its own line through
      // the gap tolerance. Guarded by the rule's third condition.
      const cells = [line("short", 10000, 10200), line("long", 10300, 12300)]
      expect(review([cue("s", 10250, 10450), cue("l", 10300, 12300)], cells).pairs)
        .toEqual([["s", "short", null], ["l", "long", null]])
    })

    it("an extra cue that only grazes a line another cue holds", () => {
      // It overlaps line A by 100 of its 900ms and otherwise sits in the gap.
      // It doesn't CLAIM A, so nobody competed: it is just an unmatched cue.
      const cells = [line("A", 1000, 1800), line("B", 3000, 3800)]
      const r = review([cue("a", 1000, 1800), cue("extra", 1700, 2600), cue("b", 3000, 3800)], cells)
      expect(r.pairs).toEqual([["a", "A", null], ["b", "B", null]])
      expect(r.orphans).toEqual([["extra", "noLineInReach"]])
    })

    it("a missing cue, and an extra cue that reaches no line", () => {
      const r = review([cue("a", 1000, 1800), cue("c", 3000, 3800), cue("extra", 50000, 50800)], three)
      expect(r.pairs).toEqual([["a", "A", null], ["c", "C", null]])
      expect(r.orphans).toEqual([["extra", "noLineInReach"]])
    })

    it("the tight grid with the neighbour's own cue absent — ruled user error, so only an uncovered line", () => {
      expect(review([cue("T1", 10500, 10900), cue("T3", 20000, 20400)], tight).pairs)
        .toEqual([["T1", "L2", null], ["T3", "L3", null]])
    })
  })

  describe("the shared-timing flag", () => {
    const speakers = [line("S1", 10000, 10800), line("S2", 20000, 21500), line("S3", 20000, 21500), line("S4", 30000, 30800)]

    it("flags two cues with an identical range, and nothing else — timing can't tell them apart", () => {
      expect(review(
        [cue("T1", 10000, 10800), cue("PETER", 20000, 21500), cue("ANDREW", 20000, 21500), cue("T4", 30000, 30800)],
        speakers,
      ).pairs).toEqual([
        ["T1", "S1", null],
        ["PETER", "S2", "sharedTiming"],
        ["ANDREW", "S3", "sharedTiming"],
        ["T4", "S4", null],
      ])
    })
  })

  describe("the loose-fit warning", () => {
    const grid = Array.from({ length: 10 }, (_, i) => line(`L${i}`, 10000 + i * 3000, 11500 + i * 3000))
    const shifted = (by: number) => grid.map((c, i) => cue(`t${i}`, c.startMs! + by, c.endMs! + by))

    it("stays quiet on a correct file and on a small shift", () => {
      expect(matchTargetRowsByOverlap(shifted(0), grid).looseFit).toBeUndefined()
      expect(matchTargetRowsByOverlap(shifted(300), grid).looseFit).toBeUndefined()
    })

    it("speaks up when the file is offset far enough that pairings only graze their lines", () => {
      expect(matchTargetRowsByOverlap(shifted(1000), grid).looseFit).toBe(true)
    })

    it("never judges a file with too few pairings", () => {
      expect(matchTargetRowsByOverlap(shifted(1000).slice(0, 4), grid).looseFit).toBeUndefined()
    })
  })
})

describe("review flags on a full-length episode (AQU-1360)", () => {
  function episode(count: number, seed = 11): FileTargetCellRef[] {
    let s = seed
    const rand = () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
    const cells: FileTargetCellRef[] = []
    let t = 5000
    for (let i = 0; i < count; i++) {
      const dur = 800 + Math.round(rand() * 2200)
      cells.push(cell({ cellId: `c${i}`, startMs: t, endMs: t + dur }))
      t += dur + 80 + Math.round(rand() * 1420)
    }
    return cells
  }
  const as = (cells: FileTargetCellRef[], f: (ms: number) => number): TargetRow[] =>
    cells.map((c, i) => ({ ref: `cue ${i}`, text: `t${i}`, startMs: Math.round(f(c.startMs!)), endMs: Math.round(f(c.endMs!)) }))
  const flagged = (r: ReturnType<typeof matchTargetRowsByOrder>) => r.matched.filter((m) => m.flag).length
  const PAL = 25 / (24000 / 1001)

  it("a correct episode raises no flag and no loose-fit warning", () => {
    const cells = episode(650)
    const r = matchTargetRowsByOrder(as(cells, (t) => t), cells)
    expect(flagged(r)).toBe(0)
    expect(r.looseFit).toBeUndefined()
  })

  it("a rescaled episode raises no flag and no loose-fit warning either", () => {
    const cells = episode(650)
    const r = matchTargetRowsByOrder(as(cells, (t) => t / PAL), cells)
    expect(r.timebase).toBeDefined()
    expect(flagged(r)).toBe(0)
    expect(r.looseFit).toBeUndefined()
  })

  it("a shifted episode, once shifted back, raises no flag and no loose-fit warning", () => {
    const cells = episode(650)
    const r = matchTargetRowsByOrder(as(cells, (t) => t + 2000), cells)
    expect(r.timebase?.offsetMs).toBeDefined()
    expect(flagged(r)).toBe(0)
    expect(r.looseFit).toBeUndefined()
  })

  it("left unshifted (the tickbox unticked), it raises the loose-fit warning", () => {
    const cells = episode(650)
    const r = matchTargetRowsByOrder(as(cells, (t) => t + 2000), cells, { applyOffset: false })
    expect(r.timebase).toBeUndefined()
    expect(r.looseFit).toBe(true)
  })
})

describe("text a line already holds (AQU-1360)", () => {
  const cells = [
    cell({ cellId: "same", canonicalRef: "GEN 1:1", translated: "In the beginning" }),
    cell({ cellId: "spaced", canonicalRef: "GEN 1:2", translated: "  And the earth " }),
    cell({ cellId: "different", canonicalRef: "GEN 1:3", translated: "old wording" }),
    cell({ cellId: "empty", canonicalRef: "GEN 1:4" }),
  ]
  const result = matchTargetRowsByRef(
    [
      { ref: "GEN 1:1", text: "In the beginning" },
      { ref: "GEN 1:2", text: "And the earth" },
      { ref: "GEN 1:3", text: "new wording" },
      { ref: "GEN 1:4", text: "fresh" },
    ],
    cells,
  )
  const by = (id: string) => result.matched.find((m) => m.cellId === id)!

  it("is 'already there', not a conflict — even when only surrounding spaces differ", () => {
    expect(by("same")).toMatchObject({ alreadyThere: true, hasConflict: false })
    expect(by("spaced")).toMatchObject({ alreadyThere: true, hasConflict: false })
  })

  it("leaves real conflicts and fresh lines exactly as before", () => {
    expect(by("different")).toMatchObject({ hasConflict: true })
    expect(by("different")).not.toHaveProperty("alreadyThere")
    expect(by("empty")).toMatchObject({ hasConflict: false })
    expect(by("empty")).not.toHaveProperty("alreadyThere")
  })
})

describe("showing the line's own timecode (AQU-1360)", () => {
  const lines = [
    cell({ cellId: "a", startMs: 10000, endMs: 10800, cueRef: "00:00:10.000 --> 00:00:10.800" }),
    cell({ cellId: "b", startMs: 20000, endMs: 20800, cueRef: "00:00:20.000 --> 00:00:20.800" }),
  ]
  const refs = (rows: TargetRow[]) => matchTargetRowsByOverlap(rows, lines).matched.map((m) => m.cellRef ?? null)

  it("stays out of the way when the cue sits exactly on its line", () => {
    expect(refs([
      { ref: "00:00:10.000 --> 00:00:10.800", text: "a", startMs: 10000, endMs: 10800 },
      { ref: "00:00:20.000 --> 00:00:20.800", text: "b", startMs: 20000, endMs: 20800 },
    ])).toEqual([null, null])
  })

  it("appears when the cue is shifted, so drift is visible without reading the text", () => {
    expect(refs([{ ref: "00:00:10.300 --> 00:00:11.100", text: "a", startMs: 10300, endMs: 11100 }]))
      .toEqual(["00:00:10.000 --> 00:00:10.800"])
  })

  it("ignores a frame's rounding, up to 30ms, and shows anything past it", () => {
    expect(refs([{ ref: "00:00:10.025 --> 00:00:10.775", text: "a", startMs: 10025, endMs: 10775 }]))
      .toEqual([null])
    expect(refs([{ ref: "00:00:10.030 --> 00:00:10.800", text: "a", startMs: 10030, endMs: 10800 }]))
      .toEqual([null])
    expect(refs([{ ref: "00:00:10.031 --> 00:00:10.800", text: "a", startMs: 10031, endMs: 10800 }]))
      .toEqual(["00:00:10.000 --> 00:00:10.800"])
    expect(refs([{ ref: "00:00:10.000 --> 00:00:10.769", text: "a", startMs: 10000, endMs: 10769 }]))
      .toEqual(["00:00:10.000 --> 00:00:10.800"])
  })

  it("compares numbers, not strings — an SRT comma is not drift", () => {
    expect(refs([{ ref: "00:00:10,000 --> 00:00:10,800", text: "a", startMs: 10000, endMs: 10800 }]))
      .toEqual([null])
  })

  it("stays out of the way on a file the frame-rate correction lined up", () => {
    const PAL = 25 / (24000 / 1001)
    const cells = Array.from({ length: 40 }, (_, i) =>
      cell({ cellId: `c${i}`, startMs: 5000 + i * 2500, endMs: 6200 + i * 2500 + (i % 3) * 300, cueRef: `line ${i}` }))
    const rows = cells.map((c, i) => ({
      ref: `cue ${i}`, text: `t${i}`, startMs: Math.round(c.startMs! / PAL), endMs: Math.round(c.endMs! / PAL),
    }))
    const result = matchTargetRowsByOrder(rows, cells)
    expect(result.timebase).toBeDefined()
    expect(result.matched.filter((m) => m.cellRef)).toHaveLength(0)
  })
})
