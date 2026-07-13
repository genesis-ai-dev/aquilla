// Tests for the Translation Notes TSV parser (AQU-179)

import { describe, it, expect } from "vitest"
import { parseTnTsv } from "./translation-notes"

// Standard unfoldingWord three-column format
const UW_FIXTURE = `Book\tChapter\tVerse\tID\tSupportReference\tOrigQuote\tOccurrence\tNote
GEN\t1\t1\tfigs-merism\trc://*/tw/dict/bible/other/creation\tהַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ\t1\tThis is a merism for everything.
GEN\t1\t1\tgrammar-connect\t\tבָּרָ֣א\t1\tThis marks the beginning of a new section.
GEN\t1\t2\trcl-unknown\t\t\t1\tNote for verse 2.`

// Case-insensitive column names
const LOWERCASE_FIXTURE = `book\tchapter\tverse\tid\tnote
MAT\t1\t1\tfigs-123\tA note about MAT 1:1.
MAT\t2\t5\tfigs-456\tA note about MAT 2:5.`

// BOM prefix
const BOM_FIXTURE = "﻿" + UW_FIXTURE

// Windows CRLF line endings
const CRLF_FIXTURE = UW_FIXTURE.replace(/\n/g, "\r\n")

// Rows with missing book/chapter/verse (should be skipped)
const WITH_SKIPPED_ROWS = `Book\tChapter\tVerse\tID\tNote
GEN\t1\t1\tok-row\tGood row.
\t\t\tbad-row\tBad row — no ref.
GEN\t2\t1\tok-row2\tGood row 2.`

// Minimal — no note id or support ref
const MINIMAL_FIXTURE = `Book\tChapter\tVerse\tNote
MAT\t5\t3\tBlessed are the poor in spirit.`

describe("parseTnTsv — basic parsing", () => {
  it("parses all valid rows", () => {
    const result = parseTnTsv(UW_FIXTURE)
    expect(result.notes).toHaveLength(3)
    expect(result.skippedCount).toBe(0)
  })

  it("builds correct canonical_ref", () => {
    const result = parseTnTsv(UW_FIXTURE)
    expect(result.notes[0].canonicalRef).toBe("GEN 1:1")
    expect(result.notes[1].canonicalRef).toBe("GEN 1:1")
    expect(result.notes[2].canonicalRef).toBe("GEN 1:2")
  })

  it("extracts noteId and supportRef", () => {
    const result = parseTnTsv(UW_FIXTURE)
    expect(result.notes[0].noteId).toBe("figs-merism")
    expect(result.notes[0].supportRef).toBe("rc://*/tw/dict/bible/other/creation")
    // Second row has no support ref
    expect(result.notes[1].supportRef).toBeUndefined()
  })

  it("body excludes metadata columns", () => {
    const result = parseTnTsv(UW_FIXTURE)
    // Body should contain the note text, not book/chapter/verse/id/supportref
    expect(result.notes[0].body).toContain("merism")
    expect(result.notes[0].body).not.toContain("GEN")
    expect(result.notes[0].body).not.toContain("figs-merism")
  })

  it("returns one TranslatableString per valid row", () => {
    const result = parseTnTsv(UW_FIXTURE)
    expect(result.strings).toHaveLength(3)
  })

  it("strings have correct group and globalReferences", () => {
    const result = parseTnTsv(UW_FIXTURE)
    expect(result.strings[0].group).toBe("GEN 1:1")
    expect(result.strings[0].globalReferences).toEqual(["GEN 1:1"])
  })

  it("strings have correct section (book + chapter)", () => {
    const result = parseTnTsv(UW_FIXTURE)
    expect(result.strings[0].section).toBe("GEN 1")
    expect(result.strings[2].section).toBe("GEN 1")
  })

  it("strings have unique UUIDs", () => {
    const result = parseTnTsv(UW_FIXTURE)
    const ids = result.strings.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("parseTnTsv — column name variants", () => {
  it("handles lowercase column names", () => {
    const result = parseTnTsv(LOWERCASE_FIXTURE)
    expect(result.notes).toHaveLength(2)
    expect(result.notes[0].canonicalRef).toBe("MAT 1:1")
    expect(result.notes[1].canonicalRef).toBe("MAT 2:5")
  })

  it("handles minimal fixture (no id/supportref columns)", () => {
    const result = parseTnTsv(MINIMAL_FIXTURE)
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0].canonicalRef).toBe("MAT 5:3")
    expect(result.notes[0].noteId).toBeUndefined()
    expect(result.notes[0].supportRef).toBeUndefined()
    expect(result.notes[0].body).toBe("Blessed are the poor in spirit.")
  })
})

describe("parseTnTsv — robustness", () => {
  it("handles UTF-8 BOM prefix", () => {
    const result = parseTnTsv(BOM_FIXTURE)
    expect(result.notes).toHaveLength(3)
    expect(result.notes[0].canonicalRef).toBe("GEN 1:1")
  })

  it("handles Windows CRLF line endings", () => {
    const result = parseTnTsv(CRLF_FIXTURE)
    expect(result.notes).toHaveLength(3)
  })

  it("skips rows with missing book/chapter/verse", () => {
    const result = parseTnTsv(WITH_SKIPPED_ROWS)
    expect(result.notes).toHaveLength(2)
    expect(result.skippedCount).toBe(1)
    expect(result.notes[0].canonicalRef).toBe("GEN 1:1")
    expect(result.notes[1].canonicalRef).toBe("GEN 2:1")
  })

  it("throws on empty input", () => {
    expect(() => parseTnTsv("")).toThrow()
  })

  it("translated is always empty string", () => {
    const result = parseTnTsv(UW_FIXTURE)
    for (const s of result.strings) {
      expect(s.translated).toBe("")
    }
  })

  it("type is always 'text'", () => {
    const result = parseTnTsv(UW_FIXTURE)
    for (const s of result.strings) {
      expect(s.type).toBe("text")
    }
  })
})
