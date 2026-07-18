/**
 * Tests for AQU-316 spreadsheet parser and column mapping utilities.
 * AQU-439: added tests for splitCastName (camera-angle splitting).
 */

import { describe, it, expect } from "vitest"
import {
  parseCsvToSheet,
  applyColumnMapping,
  mappedRowsToStrings,
  generateLabelTemplate,
  matchPairedRowsToSourceCells,
  splitCastName,
} from "./spreadsheet"

// ─── AQU-439: splitCastName ──────────────────────────────────────────────────

describe("splitCastName", () => {
  it("returns voice + cameraState when a trailing (angle) group is present", () => {
    expect(splitCastName("Mary Magdalene   (on)")).toEqual({
      voice: "Mary Magdalene",
      cameraState: "on",
    })
  })

  it("handles single-space separator", () => {
    expect(splitCastName("Peter (off)")).toEqual({ voice: "Peter", cameraState: "off" })
  })

  it("maps group → mixed (synonym)", () => {
    expect(splitCastName("Crowd (group)")).toEqual({ voice: "Crowd", cameraState: "mixed" })
  })

  it("maps mixed → mixed", () => {
    expect(splitCastName("Narrator (mixed)")).toEqual({ voice: "Narrator", cameraState: "mixed" })
  })

  it("returns undefined cameraState when no angle group is present", () => {
    expect(splitCastName("Narrator")).toEqual({ voice: "Narrator", cameraState: undefined })
  })

  it("returns undefined cameraState for an empty string", () => {
    expect(splitCastName("")).toEqual({ voice: "", cameraState: undefined })
  })

  it("trims surrounding whitespace from the input", () => {
    expect(splitCastName("  John  (on)  ")).toEqual({ voice: "John", cameraState: "on" })
  })

  it("falls back to mixed for unrecognised angle synonyms", () => {
    // Unknown angles should map to "mixed" (safe default, not fail)
    expect(splitCastName("Anna (side)")).toEqual({ voice: "Anna", cameraState: "mixed" })
  })

  it("does NOT strip parens that are mid-name (not trailing angle group)", () => {
    // A name like "God (voice)" should be treated as name + angle
    const result = splitCastName("God (voice)")
    expect(result.voice).toBe("God")
    expect(result.cameraState).toBe("mixed") // "voice" → unknown → mixed fallback
  })

  it("preserves names that contain parens as part of a longer string (no trailing group)", () => {
    // If the parens are part of the name with no space before, no split.
    // e.g. "Mary(on)" — no space before paren → no angle split
    const result = splitCastName("Mary(on)")
    expect(result.voice).toBe("Mary(on)")
    expect(result.cameraState).toBeUndefined()
  })
})

describe("parseCsvToSheet", () => {
  it("returns rows from a simple CSV", () => {
    const sheet = parseCsvToSheet("a,b,c\n1,2,3\n4,5,6", "test.csv")
    expect(sheet.name).toBe("test.csv")
    expect(sheet.rows).toHaveLength(3)
    expect(sheet.rows[0]).toEqual(["a", "b", "c"])
    expect(sheet.rows[1]).toEqual(["1", "2", "3"])
  })

  it("handles quoted fields with commas", () => {
    const sheet = parseCsvToSheet('"hello, world","foo bar"\nval1,val2', "x.csv")
    expect(sheet.rows[0]).toEqual(["hello, world", "foo bar"])
  })

  it("returns a single-row sheet for a single line", () => {
    const sheet = parseCsvToSheet("source,target", "x.csv")
    expect(sheet.rows).toHaveLength(1)
  })
})

describe("applyColumnMapping", () => {
  const rows = [
    ["ref", "source", "target", "cast"],
    ["GEN 1:1", "In the beginning", "Au commencement", "Narrator"],
    ["GEN 1:2", "The earth was formless", "La terre était informe", ""],
  ]

  it("maps columns correctly with header", () => {
    const mapping = { sourceCol: 1, targetCol: 2, labelCol: 0, castCol: 3, startCol: null, endCol: null }
    const result = applyColumnMapping(rows, mapping, true)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("In the beginning")
    expect(result[0].translated).toBe("Au commencement")
    expect(result[0].ref).toBe("GEN 1:1")
    expect(result[0].castName).toBe("Narrator")
    expect(result[1].castName).toBeUndefined()
  })

  it("skips rows with empty source column", () => {
    const rowsWithEmpty = [["ref", "source"], ["GEN 1:1", ""], ["GEN 1:2", "Text"]]
    const mapping = { sourceCol: 1, targetCol: null, labelCol: 0, castCol: null, startCol: null, endCol: null }
    const result = applyColumnMapping(rowsWithEmpty, mapping, true)
    expect(result).toHaveLength(1)
    expect(result[0].ref).toBe("GEN 1:2")
  })

  it("works without header", () => {
    const mapping = { sourceCol: 0, targetCol: 1, labelCol: null, castCol: null, startCol: null, endCol: null }
    const result = applyColumnMapping(rows, mapping, false) // no header skip
    expect(result[0].original).toBe("ref") // header row treated as data
    expect(result).toHaveLength(3)
  })

  it("parses HH:MM:SS timestamps", () => {
    const tsRows = [["00:01:00", "00:01:30", "Hello"]]
    const mapping = { sourceCol: 2, targetCol: null, labelCol: null, castCol: null, startCol: 0, endCol: 1 }
    const result = applyColumnMapping(tsRows, mapping, false)
    expect(result[0].start).toBe(60)
    expect(result[0].end).toBe(90)
  })

  it("parses bare numeric timestamps", () => {
    const tsRows = [["3.5", "7.0", "text"]]
    const mapping = { sourceCol: 2, targetCol: null, labelCol: null, castCol: null, startCol: 0, endCol: 1 }
    const result = applyColumnMapping(tsRows, mapping, false)
    expect(result[0].start).toBe(3.5)
    expect(result[0].end).toBe(7)
  })
})

describe("mappedRowsToStrings", () => {
  it("converts mapped rows to TranslatableString shape", () => {
    const rows = [
      { id: "abc", original: "Hello", translated: "Hola", ref: "GEN 1:1", castName: "Narrator", start: undefined, end: undefined },
    ]
    const strings = mappedRowsToStrings(rows)
    expect(strings).toHaveLength(1)
    expect(strings[0].original).toBe("Hello")
    expect(strings[0].translated).toBe("Hola")
    expect(strings[0].group).toBe("GEN 1:1")
    expect(strings[0].speaker).toBe("Narrator")
  })

  it("uses fallback ref when ref is empty", () => {
    const rows = [
      { id: "xyz", original: "text", translated: "", ref: "", castName: undefined, start: undefined, end: undefined },
    ]
    const strings = mappedRowsToStrings(rows)
    expect(strings[0].group).toBe("row-1")
  })
})

describe("generateLabelTemplate", () => {
  it("produces a CSV with a BOM and correct columns", () => {
    const csv = generateLabelTemplate(["GEN 1:1", "GEN 1:2"])
    expect(csv.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(csv).toContain("ref,cast_name,note")
    expect(csv).toContain('"GEN 1:1",,')
    expect(csv).toContain('"GEN 1:2",,')
  })

  it("handles empty refs array", () => {
    const csv = generateLabelTemplate([])
    expect(csv).toContain("ref,cast_name,note")
  })

  it("escapes double quotes in refs", () => {
    const csv = generateLabelTemplate(['REF "1"'])
    expect(csv).toContain('"REF ""1"""')
  })
})

describe("matchPairedRowsToSourceCells", () => {
  const sourceCells: import("./spreadsheet").MatchableSourceCell[] = [
    { cellId: "cell-1", fileId: "file-1", translated: "", canonicalRef: "GEN 1:1", sourceEventId: "evt-1" },
    { cellId: "cell-2", fileId: "file-1", translated: "existing", canonicalRef: "GEN 1:2", sourceEventId: "evt-2" },
    { cellId: "cell-3", fileId: "file-1", translated: "", canonicalRef: "GEN 1:3", sourceEventId: "evt-3" },
  ]

  const mappedRows = [
    { id: "r1", original: "In the beginning", translated: "Au commencement", ref: "GEN 1:1", castName: undefined, start: undefined, end: undefined },
    { id: "r2", original: "The earth", translated: "La terre", ref: "GEN 1:2", castName: undefined, start: undefined, end: undefined },
    { id: "r3", original: "Orphan", translated: "Orphelin", ref: "GEN 99:99", castName: undefined, start: undefined, end: undefined },
  ]

  it("matches rows to source cells by ref", () => {
    const result = matchPairedRowsToSourceCells(mappedRows, sourceCells)
    expect(result.matched).toHaveLength(2)
    expect(result.matched[0].cellId).toBe("cell-1")
    expect(result.matched[0].hasConflict).toBe(false)
    expect(result.matched[1].cellId).toBe("cell-2")
    expect(result.matched[1].hasConflict).toBe(true)
  })

  it("puts unmatched rows in orphans", () => {
    const result = matchPairedRowsToSourceCells(mappedRows, sourceCells)
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0].ref).toBe("GEN 99:99")
  })

  it("counts unmatched source cells", () => {
    const result = matchPairedRowsToSourceCells(mappedRows, sourceCells)
    // GEN 1:3 has no incoming row
    expect(result.unmatchedSourceCount).toBe(1)
  })

  it("sets parentId from sourceEventId when no targetEventId", () => {
    const result = matchPairedRowsToSourceCells(mappedRows, sourceCells)
    expect(result.matched[0].parentId).toBe("evt-1")
  })
})
