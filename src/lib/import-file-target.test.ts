import { describe, it, expect } from "vitest"
import {
  matchTargetRowsByRef,
  matchTargetRowsByOrder,
  usfmToTargetRows,
  subtitleToTargetRows,
  vttToTargetRows,
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
      { ref: "00:00:01.000 --> 00:00:04.000", text: "Hello world" },
      { ref: "00:00:05.000 --> 00:00:08.000", text: "Second cue" },
    ])
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
      { ref: "00:01:03.209 --> 00:01:03.667", text: "Abba?" },
      { ref: "00:01:06.626 --> 00:01:07.751", text: "You should be sleeping, little one." },
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
