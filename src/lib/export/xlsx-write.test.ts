// The corrected sheet has to go back to Anna as a file her pipeline can open.
// (AQU-646, 2026-08-19)
//
// Almost every test here is a ROUND TRIP: build a workbook with the writer,
// then read it back with the app's own xlsx reader and check that what comes
// out is what went in. That shape is deliberate. Asserting on the XML the
// writer just produced only proves the writer agrees with itself, which is
// exactly the failure mode of a hand-rolled format — the file looks right in a
// string comparison and no spreadsheet on earth will open it. Going through
// `parseXlsxToSheets` puts a second, independently written implementation
// between the assertion and the code under test.
//
// The reader normalises everything to strings, so numbers come back as their
// text. That is the reader's contract rather than a lossy write, and the tests
// below say so where it shows.

import { describe, it, expect } from "vitest"
import JSZip from "jszip"

import { buildXlsx, columnLetter, escapeXml, sanitizeSheetNames } from "./xlsx-write"
import type { XlsxCell, XlsxSheet } from "./xlsx-write"
import { parseXlsxToSheets } from "@/lib/parsers/spreadsheet"

/** Build then immediately read back — the shape almost every test below wants. */
async function roundTrip(sheets: XlsxSheet[]) {
  const blob = await buildXlsx(sheets)
  return parseXlsxToSheets(await blob.arrayBuffer())
}

/** Shorthand: a row of plain, unhighlighted values. */
const row = (...values: (string | number | null)[]): XlsxCell[] =>
  values.map((value) => ({ value }))

describe("turning a column index into a spreadsheet column letter", () => {
  it("counts A to Z for the first twenty-six", () => {
    expect(columnLetter(0)).toBe("A")
    expect(columnLetter(1)).toBe("B")
    expect(columnLetter(25)).toBe("Z")
  })

  it("carries into two letters without a zero digit", () => {
    // The bug this guards against: treating this as ordinary base-26 gives
    // "BA" where Excel says "AA", and every column past Z lands one place to
    // the side for the rest of the file.
    expect(columnLetter(26)).toBe("AA")
    expect(columnLetter(27)).toBe("AB")
    expect(columnLetter(51)).toBe("AZ")
    expect(columnLetter(52)).toBe("BA")
  })

  it("carries again at the end of the two-letter range", () => {
    expect(columnLetter(701)).toBe("ZZ")
    expect(columnLetter(702)).toBe("AAA")
    expect(columnLetter(16383)).toBe("XFD") // Excel's last column.
  })

  it("agrees with the reader's own letter-to-index conversion at every carry", () => {
    // The reader converts the other way (`colLetterToIndex`). If the two ever
    // disagree, a file we wrote reads back with its columns shifted — so check
    // the places a carry happens, which is where an off-by-one hides.
    for (const index of [0, 25, 26, 27, 51, 52, 701, 702, 703, 18277]) {
      const letters = columnLetter(index)
      const back = [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1
      expect(back).toBe(index)
    }
  })

  it("refuses a negative or fractional index rather than writing a nonsense reference", () => {
    expect(() => columnLetter(-1)).toThrow()
    expect(() => columnLetter(1.5)).toThrow()
  })
})

describe("a workbook read back by our own xlsx reader", () => {
  it("gives back the headers and rows exactly as they went in", async () => {
    const sheets = await roundTrip([
      {
        name: "Characters",
        headers: ["ref", "cast_name", "note"],
        rows: [row("MAT 1:1", "MARY MAGDALENE", "on"), row("MAT 1:2", "NICODEMUS", "off")],
      },
    ])

    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows).toEqual([
      ["ref", "cast_name", "note"],
      ["MAT 1:1", "MARY MAGDALENE", "on"],
      ["MAT 1:2", "NICODEMUS", "off"],
    ])
  })

  it("keeps two sheets in the order they were given, each under its own tab name", async () => {
    const sheets = await roundTrip([
      { name: "Subtitle cast", headers: ["ref"], rows: [row("A")] },
      { name: "Audio cast", headers: ["ref"], rows: [row("B")] },
    ])

    expect(sheets.map((s) => s.name)).toEqual(["Subtitle cast", "Audio cast"])
    expect(sheets[0].rows[1]).toEqual(["A"])
    expect(sheets[1].rows[1]).toEqual(["B"])
  })

  it("writes numbers as numbers, so a timecode column arrives as its value and not as a blank", async () => {
    // Numeric cells take a different branch in both writer and reader (no `t`
    // attribute, `<v>` instead of `<is><t>`), which is exactly where a whole
    // column could quietly come back empty.
    const sheets = await roundTrip([
      {
        name: "Timings",
        headers: ["line", "start", "end"],
        rows: [row(1, 0, 12.5), row(2, 12.5, 90.25), row(3, -4, 0.1)],
      },
    ])

    expect(sheets[0].rows.slice(1)).toEqual([
      ["1", "0", "12.5"],
      ["2", "12.5", "90.25"],
      ["3", "-4", "0.1"],
    ])
  })

  it("keeps an empty cell in the middle of a row from shifting the cells after it", async () => {
    const sheets = await roundTrip([
      {
        name: "Cast",
        headers: ["ref", "cast_name", "note"],
        rows: [row("MAT 1:1", null, "unassigned")],
      },
    ])

    expect(sheets[0].rows[1]).toEqual(["MAT 1:1", "", "unassigned"])
  })

  it("keeps an empty cell at the END of a row, where the row would otherwise just get shorter", async () => {
    // The reason empty cells are written as empty inline strings rather than as
    // the self-closing `<c r="C2"/>` Excel would emit: our reader only sees
    // cells that have a closing tag, so a self-closed trailing cell would
    // vanish and the row would come back one column short — which a caller
    // lining rows up against a header reads as a missing note, not a missing
    // cell.
    const sheets = await roundTrip([
      { name: "Cast", headers: ["ref", "cast_name", "note"], rows: [row("MAT 1:1", "PETER", null)] },
    ])

    expect(sheets[0].rows[1]).toEqual(["MAT 1:1", "PETER", ""])
    expect(sheets[0].rows[1]).toHaveLength(3)
  })

  it("survives the XML-special characters a character name really does contain", async () => {
    // `MARY MAGDALENE'S FATHER` is the name that broke the reader in August:
    // written by the client's tooling with the apostrophe as an entity, it came
    // back as a literal `&apos;` and would have been filed as a second,
    // separate character. Escaping on the way out has to be undone exactly on
    // the way back in, or we recreate that bug from the other end.
    const sheets = await roundTrip([
      {
        name: "Cast",
        headers: ["cast_name"],
        rows: [
          row("MARY MAGDALENE'S FATHER"),
          row("Simon & Andrew"),
          row('He said "no"'),
          row("<NARRATOR>"),
          row("a & b < c > d \" e ' f"),
        ],
      },
    ])

    expect(sheets[0].rows.slice(1)).toEqual([
      ["MARY MAGDALENE'S FATHER"],
      ["Simon & Andrew"],
      ['He said "no"'],
      ["<NARRATOR>"],
      ["a & b < c > d \" e ' f"],
    ])
  })

  it("survives accented and non-Latin names", async () => {
    const sheets = await roundTrip([
      {
        name: "Cast",
        headers: ["cast_name"],
        rows: [row("José"), row("Zoë Ntséhehe"), row("Ана")],
      },
    ])

    expect(sheets[0].rows.slice(1)).toEqual([["José"], ["Zoë Ntséhehe"], ["Ана"]])
  })

  it("preserves the leading and trailing spaces a hand-maintained sheet is full of", async () => {
    // Without `xml:space="preserve"` a conforming reader is free to trim these,
    // and the corrected sheet quietly stops matching the client's original.
    const sheets = await roundTrip([
      { name: "Cast", headers: ["cast_name"], rows: [row("  PETER  "), row("   ")] },
    ])

    expect(sheets[0].rows[1]).toEqual(["  PETER  "])
    expect(sheets[0].rows[2]).toEqual(["   "])
  })

  it("puts the thirtieth column under the header it belongs to, not one place over", async () => {
    // A thirty-column sheet crosses the Z boundary four columns in from the
    // end. If the column-letter conversion were wrong, everything up to Z would
    // still be perfect and only the tail would be wrong — the failure that is
    // hardest to notice by eye and easiest to ship.
    const headers = Array.from({ length: 30 }, (_, i) => `col${i + 1}`)
    const values = Array.from({ length: 30 }, (_, i) => `v${i + 1}`)

    const sheets = await roundTrip([{ name: "Wide", headers, rows: [row(...values)] }])

    expect(sheets[0].rows[0]).toHaveLength(30)
    expect(sheets[0].rows[0][29]).toBe("col30")
    expect(sheets[0].rows[1][29]).toBe("v30")
    expect(sheets[0].rows[0]).toEqual(headers)
    expect(sheets[0].rows[1]).toEqual(values)
  })

  it("writes ragged rows as they were given rather than padding them out", async () => {
    const sheets = await roundTrip([
      { name: "Ragged", headers: ["a", "b", "c"], rows: [row("1"), row("1", "2", "3")] },
    ])

    expect(sheets[0].rows[1]).toEqual(["1"])
    expect(sheets[0].rows[2]).toEqual(["1", "2", "3"])
  })
})

describe("marking the cells we corrected", () => {
  it("round-trips a highlighted workbook with its values untouched", async () => {
    // Highlighting is cosmetic and must stay that way: the file has to read
    // back identically whether or not a cell carries the fill.
    const sheets = await roundTrip([
      {
        name: "Resolved",
        headers: ["ref", "was", "now"],
        rows: [
          [{ value: "MAT 1:1" }, { value: "NICODEMUS" }, { value: "SIMON", highlight: true }],
          [{ value: "MAT 1:2" }, { value: "PETER" }, { value: "PETER" }],
        ],
      },
    ])

    expect(sheets[0].rows).toEqual([
      ["ref", "was", "now"],
      ["MAT 1:1", "NICODEMUS", "SIMON"],
      ["MAT 1:2", "PETER", "PETER"],
    ])
  })

  it("highlights a number and an empty cell without changing what they contain", async () => {
    const sheets = await roundTrip([
      {
        name: "Resolved",
        headers: ["line", "note"],
        rows: [[{ value: 12.5, highlight: true }, { value: null, highlight: true }]],
      },
    ])

    expect(sheets[0].rows[1]).toEqual(["12.5", ""])
  })

  it("adds exactly one style to the workbook, not a styling system", async () => {
    // The point of the highlight is that it is the ONLY thing this writer says
    // visually. If `cellXfs` ever grows past two entries, someone has started
    // building a general styling layer inside an export that does not need one.
    const blob = await buildXlsx([
      { name: "Resolved", headers: ["a"], rows: [[{ value: "x", highlight: true }]] },
    ])
    const styles = await (await JSZip.loadAsync(await blob.arrayBuffer()))
      .file("xl/styles.xml")!
      .async("string")

    expect(styles).toContain('<cellXfs count="2">')
    expect(styles).toContain('patternType="solid"')
    // Excel refuses to open a workbook whose first two fills are not these two,
    // in this order — which is why the solid fill can only ever be the third.
    expect(styles.indexOf('patternType="none"')).toBeLessThan(styles.indexOf('patternType="gray125"'))
    expect(styles.indexOf('patternType="gray125"')).toBeLessThan(styles.indexOf('patternType="solid"'))
  })

  it("only styles the cells that asked for it", async () => {
    const blob = await buildXlsx([
      {
        name: "Resolved",
        headers: ["a", "b"],
        rows: [[{ value: "plain" }, { value: "changed", highlight: true }]],
      },
    ])
    const sheet = await (await JSZip.loadAsync(await blob.arrayBuffer()))
      .file("xl/worksheets/sheet1.xml")!
      .async("string")

    expect(sheet).toContain('<c r="B2" s="1"')
    expect(sheet).toContain('<c r="A2" t="inlineStr"')
    expect(sheet.match(/ s="1"/g)).toHaveLength(1)
  })
})

describe("worksheet tab names", () => {
  it("replaces the characters Excel refuses to open a file over", () => {
    expect(sanitizeSheetNames(["Ep 101: cast", "a/b", "a\\b", "who?", "star*", "[bracket]"])).toEqual([
      "Ep 101_ cast",
      "a_b",
      "a_b (2)",
      "who_",
      "star_",
      "_bracket_",
    ])
  })

  it("caps a long name at Excel's thirty-one characters", () => {
    const [name] = sanitizeSheetNames(["The Chosen season two episode six audio character sheet"])
    expect(name).toHaveLength(31)
    expect(name).toBe("The Chosen season two episode s")
  })

  it("makes duplicates unique, treating names that differ only in case as duplicates", () => {
    // Excel considers "Cast" and "cast" the same tab and refuses a workbook
    // holding both, so uniqueness has to be decided case-insensitively even
    // though the names we write keep the case they arrived in.
    expect(sanitizeSheetNames(["Cast", "Cast", "cast", "CAST"])).toEqual([
      "Cast",
      "Cast (2)",
      "cast (3)",
      "CAST (4)",
    ])
  })

  it("keeps a de-duplicated long name inside the cap", () => {
    const long = "Character sheet for episode 101"
    const names = sanitizeSheetNames([long, long])
    expect(names[0]).toHaveLength(31)
    expect(names[1].length).toBeLessThanOrEqual(31)
    expect(names[1].endsWith(" (2)")).toBe(true)
  })

  it("gives an empty or whitespace-only name something to be called", () => {
    expect(sanitizeSheetNames(["", "   ", "'"])).toEqual(["Sheet1", "Sheet2", "Sheet3"])
  })

  it("survives the round trip with the sanitized name on the tab", async () => {
    const sheets = await roundTrip([
      { name: "Ep 101: cast", headers: ["a"], rows: [row("x")] },
      { name: "Ep 101: cast", headers: ["a"], rows: [row("y")] },
    ])

    expect(sheets.map((s) => s.name)).toEqual(["Ep 101_ cast", "Ep 101_ cast (2)"])
  })

  it("does not let a quote in a tab name break out of the attribute it sits in", async () => {
    // A tab name may legally contain quotes, and the workbook part is the one
    // place where an unescaped one would close the attribute early and produce
    // a file that reads back as having no worksheets at all.
    const sheets = await roundTrip([
      { name: 'Anna and the "final" cast', headers: ["a"], rows: [row("x")] },
    ])

    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBe('Anna and the "final" cast')
    expect(sheets[0].rows[1]).toEqual(["x"])
  })
})

describe("text that cannot legally be put in an XML file", () => {
  it("drops control characters instead of writing a file nothing will open", async () => {
    // There is no escape for these — `&#11;` is itself illegal in XML 1.0 — so
    // the choice is dropping them or shipping a corrupt workbook. A name pasted
    // out of one spreadsheet into another really can carry one; a vertical tab
    // is what a line break inside an Excel cell becomes on some routes out.
    const verticalTab = String.fromCharCode(0x0b)
    const nulAndBell = `A${String.fromCharCode(0x00)}B${String.fromCharCode(0x07)}C`
    const sheets = await roundTrip([
      {
        name: "Cast",
        headers: ["cast_name"],
        rows: [row(`PE${verticalTab}TER`), row(nulAndBell)],
      },
    ])

    expect(sheets[0].rows[1]).toEqual(["PETER"])
    expect(sheets[0].rows[2]).toEqual(["ABC"])
  })

  it("keeps the three whitespace controls XML does allow", () => {
    expect(escapeXml("a\tb\nc\rd")).toBe("a\tb\nc\rd")
  })

  it("drops a lone surrogate, which has no UTF-8 form at all", async () => {
    const sheets = await roundTrip([
      { name: "Cast", headers: ["cast_name"], rows: [row("PE\ud800TER")] },
    ])

    expect(sheets[0].rows[1]).toEqual(["PETER"])
  })

  it("keeps a properly paired surrogate — an emoji is a real thing to find in a note column", async () => {
    const sheets = await roundTrip([
      { name: "Cast", headers: ["note"], rows: [row("done \u{1f389}")] },
    ])

    expect(sheets[0].rows[1]).toEqual(["done \u{1f389}"])
  })
})

describe("the package itself", () => {
  it("contains every part a spreadsheet reader looks for, content types first", async () => {
    const blob = await buildXlsx([
      { name: "One", headers: ["a"], rows: [row("x")] },
      { name: "Two", headers: ["a"], rows: [row("y")] },
    ])
    const names = Object.keys((await JSZip.loadAsync(await blob.arrayBuffer())).files)

    expect(names[0]).toBe("[Content_Types].xml")
    expect(names).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
      ]),
    )
  })

  it("declares a content type for every worksheet it wrote", async () => {
    const blob = await buildXlsx([
      { name: "One", headers: ["a"], rows: [] },
      { name: "Two", headers: ["a"], rows: [] },
      { name: "Three", headers: ["a"], rows: [] },
    ])
    const types = await (await JSZip.loadAsync(await blob.arrayBuffer()))
      .file("[Content_Types].xml")!
      .async("string")

    for (const n of [1, 2, 3]) {
      expect(types).toContain(`PartName="/xl/worksheets/sheet${n}.xml"`)
    }
  })

  it("hands back a blob typed as a spreadsheet, so a download saves as .xlsx and opens", async () => {
    const blob = await buildXlsx([{ name: "One", headers: ["a"], rows: [] }])
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    expect(blob.size).toBeGreaterThan(0)
  })

  it("writes a header-only sheet that still reads back as a sheet", async () => {
    const sheets = await roundTrip([{ name: "Empty", headers: ["ref", "cast_name"], rows: [] }])
    expect(sheets[0].rows).toEqual([["ref", "cast_name"]])
  })

  it("refuses to build a workbook with no sheets at all", async () => {
    // A sheetless workbook is not a valid xlsx and our own reader throws on
    // one. Failing here says which side of the pair the mistake is on.
    await expect(buildXlsx([])).rejects.toThrow(/at least one sheet/)
  })
})
