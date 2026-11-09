// Tests for the Translation Notes TSV parser (AQU-179)

import { describe, it, expect } from "vitest"
import { parseTnTsv } from "./translation-notes"
import { tsvNotesRoute } from "@/lib/dcs/routes/tsv-notes"
import type { DcsCatalogEntry, DcsManifest } from "@/lib/dcs/types"
import {
  readNoteReferenceMetadata,
  supportReferenceLabel,
} from "@/lib/notes/note-metadata"

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

// AQU-527 — the original-language quote is its own field, not prose.
//
// It used to be tab-joined into the body with the occurrence digit and the note
// text, which is why the editor's notes sidebar rendered one undifferentiated
// run and UW reported the phrase had been "taken out". These cases pin the
// split AND the seam: what this parser puts in `metadata` is read back through
// the accessor the sidebar actually calls, so a renamed key fails here rather
// than silently blanking the phrase in the panel.
describe("parseTnTsv — original-language quote (AQU-527)", () => {
  it("reads OrigQuote and Occurrence out as their own fields", () => {
    const { notes } = parseTnTsv(UW_FIXTURE)
    expect(notes[0].origQuote).toBe("הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ")
    expect(notes[0].occurrence).toBe("1")
    expect(notes[1].origQuote).toBe("בָּרָ֣א")
    // Third row's OrigQuote column is empty — absent, not an empty string.
    expect(notes[2].origQuote).toBeUndefined()
  })

  it("keeps the quote and occurrence out of the note body", () => {
    const { notes } = parseTnTsv(UW_FIXTURE)
    expect(notes[0].body).toBe("This is a merism for everything.")
    expect(notes[0].body).not.toContain("הַשָּׁמַ֖יִם")
  })

  it("accepts the older `Quote` header as well as `OrigQuote`", () => {
    const { notes } = parseTnTsv(
      `Book\tChapter\tVerse\tID\tQuote\tOccurrence\tNote\nMAT\t2\t1\tgrammar-connect\tδὲ\t1\tHere, the word Now introduces the next event.`,
    )
    expect(notes[0].origQuote).toBe("δὲ")
    expect(notes[0].body).toBe("Here, the word Now introduces the next event.")
  })

  it("carries quote, occurrence and support reference into cell metadata", () => {
    const { strings } = parseTnTsv(UW_FIXTURE)
    expect(strings[0].metadata).toEqual({
      quote: "הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ",
      occurrence: "1",
      supportReference: "rc://*/tw/dict/bible/other/creation",
    })
    // No reference columns at all → no metadata bucket, not a bucket of blanks.
    expect(parseTnTsv(MINIMAL_FIXTURE).strings[0].metadata).toBeUndefined()
  })

  it("hands the sidebar's reader a displayable phrase, script and support article", () => {
    const { strings } = parseTnTsv(UW_FIXTURE)
    const read = readNoteReferenceMetadata(strings[0].metadata)
    expect(read.quote).toBe("הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ")
    expect(read.quoteScript).toBe("he")
    // Occurrence 1 singles nothing out, so the panel shows no marker.
    expect(read.occurrence).toBeNull()
    expect(supportReferenceLabel(read.supportReference!)).toBe("creation")
  })
})

// AQU-2487 (import sweep, Nov 2): the format unfoldingWord publishes today.
// Its Reference column is "1:1"; the book is only in the file name.
describe("parseTnTsv — current unfoldingWord format (book in the file name)", () => {
  const CURRENT = `Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote
front:intro\tabc0\t\t\t\t0\t# Introduction to Genesis
1:1\tabc1\t\trc://*/ta/man/translate/figs-merism\tהַשָּׁמַ֖יִם\t1\tThis is a merism.
1:2\tabc2\t\t\t\t1\tNote for verse 2.`

  it("takes the book from the file name", () => {
    const { notes, strings, skippedCount } = parseTnTsv(CURRENT, "tn_GEN.tsv")
    expect(skippedCount).toBe(0)
    expect(notes.map((n) => n.canonicalRef)).toEqual(["GEN front:intro", "GEN 1:1", "GEN 1:2"])
    expect(strings[1].globalReferences).toEqual(["GEN 1:1"])
    expect(strings[1].section).toBe("GEN 1")
    expect(notes[1].origQuote).toBe("הַשָּׁמַ֖יִם")
  })

  it("reads the book from the other names these files are given", () => {
    for (const name of ["en_tn_57-TIT.tsv", "57-tit.tsv", "tn_tit.TSV"]) {
      expect(parseTnTsv(CURRENT, name).notes[1].canonicalRef).toBe("TIT 1:1")
    }
  })

  it("a reference that names its book keeps it, whatever the file is called", () => {
    const { notes } = parseTnTsv("Reference\tID\tNote\nMAT 5:3\tx\tBlessed.", "tn_GEN.tsv")
    expect(notes[0].canonicalRef).toBe("MAT 5:3")
  })

  it("still skips the rows when the file name names no book", () => {
    expect(parseTnTsv(CURRENT, "my_new_notes.tsv")).toMatchObject({ notes: [], skippedCount: 3 })
    expect(parseTnTsv(CURRENT)).toMatchObject({ notes: [], skippedCount: 3 })
  })

  // AQU-2487 (review, Nov 9): the book is read only where unfoldingWord puts
  // it (right after "tn", or as "NN-BOOK" at the start). "tn_GEN_rev.tsv" was
  // filed under Revelation and "notes_job.tsv" under Job, with nothing said.
  it("reads the book right after tn, whatever follows it", () => {
    for (const name of ["tn_GEN_en.tsv", "tn_GEN_v86.tsv", "hi_tn_GEN.tsv", "en_tn_01-GEN.tsv", "tn_GEN (1).tsv", "tn_GEN - Copy.tsv", "TN_gen.TSV"]) {
      expect(parseTnTsv(CURRENT, name).notes[1]?.canonicalRef, name).toBe("GEN 1:1")
    }
    expect(parseTnTsv(CURRENT, "tn_1JN.tsv").notes[1].canonicalRef).toBe("1JN 1:1")
    expect(parseTnTsv(CURRENT, "tn_OBS.tsv").notes[1].canonicalRef).toBe("OBS 1:1")
  })

  it("does not guess when the name holds two books, or the book is somewhere else", () => {
    for (const name of ["tn_GEN_rev.tsv", "rev_tn_GEN.tsv", "titus-notes-rev.tsv", "notes_job.tsv", "GEN_tn.tsv", "57-TIT_act.tsv"]) {
      expect(parseTnTsv(CURRENT, name), name).toMatchObject({ notes: [], skippedCount: 3 })
    }
  })
})

// AQU-2487 (review, Nov 9): the tile left the file's "\n" marks in the note as
// text and glued the Tags column onto it; the same file through Door43 came in
// with real line breaks and the Note text alone.
describe("parseTnTsv — reads the note the way the Door43 import does", () => {
  const FILE = [
    "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
    "front:intro\tabc0\t\t\t\t0\t# Introduction to Genesis\\n\\n## Part 1\\n\\nGenesis begins.",
    "1:1\tabc1\tkeyterm\trc://*/ta/man/translate/figs-merism\tהַשָּׁמַ֖יִם\t1\tThis is a **merism**.",
  ].join("\n")

  it("turns the file's \\n marks into line breaks and shows the note's formatting", () => {
    const { notes, strings } = parseTnTsv(FILE, "tn_GEN.tsv")
    expect(notes[0].body).toBe("# Introduction to Genesis\n\n## Part 1\n\nGenesis begins.")
    expect(strings[0].original).toBe(notes[0].body)
    expect(strings[0].originalHtml).toBe("<h1>Introduction to Genesis</h1><h2>Part 1</h2><p>Genesis begins.</p>")
    expect(strings[1].originalHtml).toBe("<p>This is a <b>merism</b>.</p>")
  })

  it("keeps Tags out of the note, beside its other reference columns", () => {
    const { notes, strings } = parseTnTsv(FILE, "tn_GEN.tsv")
    expect(notes[1].body).toBe("This is a **merism**.")
    expect(notes[1].supportRef).toBe("rc://*/ta/man/translate/figs-merism")
    expect(strings[1].metadata).toEqual({
      tags: "keyterm",
      supportReference: "rc://*/ta/man/translate/figs-merism",
      quote: "הַשָּׁמַ֖יִם",
      occurrence: "1",
    })
  })

  it("gives the same note text, formatting and reference columns as Door43 for the same file", () => {
    const door43 = tsvNotesRoute.parse({
      entry: { fullName: "unfoldingWord/en_tn" } as DcsCatalogEntry,
      manifest: {} as DcsManifest,
      projectId: "p1",
      files: new Map([["tn_GEN.tsv", FILE]]),
    })[0].cells
    const { strings } = parseTnTsv(FILE, "tn_GEN.tsv")
    expect(strings.map((s) => ({ value: s.original, valueHtml: s.originalHtml, canonicalRef: s.context, metadata: s.metadata }))).toEqual(
      door43.map((c) => ({ value: c.value, valueHtml: c.valueHtml, canonicalRef: c.canonicalRef, metadata: c.metadata })),
    )
  })
})
