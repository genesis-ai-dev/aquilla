// AQU-2559: the USFM export keeps the book's paragraph layout when a verse is
// translated, and lets a translation carry its own layout. These run the real
// lossless parser's output through the layout serializer, because the two
// only mean anything together: the parser decides where a verse span ends.

import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseUsfmLossless } from "../../src/lib/parsers/usfm-lossless"
import {
  composeUsfmLead,
  countLossyVersesWithLayout,
  renderUsfmWithLayout,
  serializeUsfmWithLayout,
  splitUsfmLead,
} from "./usfm-layout"

const BOOK = [
  "\\id GEN",
  "\\c 1",
  "\\s1 Creation",
  "\\p",
  "\\v 1 In the beginning.",
  "\\v 2 And the earth.",
  "\\p",
  "\\v 3 And God said, \\f + \\ft note\\f*",
  "\\q1 Let there be",
  "\\q2 light.",
  "\\b",
  "\\q1",
  "\\v 4 Poetry verse.",
  "\\c 2",
  "\\p",
  "\\v 1 Thus.",
  "",
].join("\n")

const out = (overrides: Record<string, string>, raw = BOOK) =>
  serializeUsfmWithLayout(parseUsfmLossless(raw), new Map(Object.entries(overrides)))

describe("serializeUsfmWithLayout", () => {
  it("returns the upload unchanged when nothing is translated", () => {
    const dir = path.resolve(__dirname, "../../src/lib/parsers/__fixtures__")
    const fixtures = readdirSync(dir).filter((f) => f.endsWith(".usfm")).map((f) => readFileSync(path.join(dir, f), "utf8"))
    const variants = [BOOK, BOOK.replace(/\n/g, "\r\n"), `\uFEFF${BOOK}`, BOOK.trimEnd(), ...fixtures]
    for (const raw of variants) {
      expect(serializeUsfmWithLayout(parseUsfmLossless(raw), new Map())).toBe(raw)
    }
  })

  it("keeps the paragraph lines that follow a translated verse", () => {
    // Before AQU-2559 both lines below lost the `\p` / `\b \q1` that opens the
    // next verse's paragraph, because those lines sit inside the previous span.
    const text = out({ "GEN 1:2": "Y la tierra.", "GEN 1:3": "Dijo Dios." })
    expect(text).toContain("\\v 2 Y la tierra.\n\\p\n\\v 3 Dijo Dios.\n\\b\n\\q1\n\\v 4 Poetry verse.")
  })

  it("applies a translation's lead in place of the lines before its verse", () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ["heading and paragraph mid-chapter", { "GEN 1:3": "\\s1 Luz\n\\p\nDijo Dios." }, "\\v 2 And the earth.\n\\s1 Luz\n\\p\n\\v 3 Dijo Dios.\n"],
      ["a new break where the source has none", { "GEN 1:2": "\\p\nY la tierra." }, "\\v 1 In the beginning.\n\\p\n\\v 2 Y la tierra.\n\\p\n\\v 3"],
      ["no break where the source has one", { "GEN 1:3": "\\nb\nDijo Dios." }, "\\v 2 And the earth.\n\\v 3 Dijo Dios.\n"],
      ["at a chapter start, after the chapter line", { "GEN 2:1": "\\s1 Rest\n\\q1\nAsí." }, "\\c 2\n\\s1 Rest\n\\q1\n\\v 1 Así.\n"],
      ["a lead alone keeps the source words", { "GEN 1:2": "\\p" }, "\\v 1 In the beginning.\n\\p\n\\v 2 And the earth.\n\\p\n\\v 3"],
    ]
    for (const [name, overrides, expected] of cases) {
      expect(out(overrides), name).toContain(expected)
    }
  })

  it("does not double the markers when a translation carries its own tail", () => {
    // A value copied from the source ends with the source's own `\p`.
    expect(out({ "GEN 1:2": "Y la tierra.\n\\p" })).toContain("\\v 2 Y la tierra.\n\\p\n\\v 3 And God said")
    expect(out({ "GEN 1:2": "Y la tierra.\n\\q1" })).toContain("\\v 2 Y la tierra.\n\\q1\n\\v 3 And God said")
  })

  it("keeps CRLF line endings around a replaced verse and its lead", () => {
    const text = out({ "GEN 1:3": "\\s1 Luz\n\\p\nDijo Dios." }, BOOK.replace(/\n/g, "\r\n"))
    expect(text).toContain("\\v 2 And the earth.\r\n\\s1 Luz\r\n\\p\r\n\\v 3 Dijo Dios.\r\n\\b\r\n")
  })

  it("reports where each span landed and whether it was translated", () => {
    const { text, spans } = renderUsfmWithLayout(parseUsfmLossless(BOOK), new Map([["GEN 1:2", "Y la tierra."]]))
    const two = spans.find((s) => s.ref === "GEN 1:2")
    const one = spans.find((s) => s.ref === "GEN 1:1")
    expect(two && text.slice(two.start, two.end)).toBe("Y la tierra.")
    expect(two?.state).toBe("translated")
    expect(one && text.slice(one.start, one.end)).toBe("In the beginning.")
    expect(one?.state).toBe("source")
  })
})

describe("countLossyVersesWithLayout", () => {
  it("counts markers inside the words, not the paragraph lines after them", () => {
    const doc = parseUsfmLossless(BOOK)
    expect(countLossyVersesWithLayout(doc, new Map([["GEN 1:2", "Y la tierra."]]))).toBe(0)
    expect(countLossyVersesWithLayout(doc, new Map([["GEN 1:3", "Dijo Dios."]]))).toBe(1)
    expect(countLossyVersesWithLayout(doc, new Map([["GEN 1:3", "\\p"]]))).toBe(0)
  })
})

describe("splitUsfmLead", () => {
  it("round-trips through composeUsfmLead and leaves ordinary text alone", () => {
    for (const value of ["\\s1 Title\n\\p\nWords", "\\nb\nWords", "\\p", "Words \\f + \\ft n\\f*", "\\q1 words on the marker line", "\\f + \\ft note\\f* Words"]) {
      const lead = splitUsfmLead(value)
      expect(composeUsfmLead(lead.blocks, lead.body)).toBe(value)
    }
    expect(splitUsfmLead("\\q1 words on the marker line").blocks).toEqual([])
    expect(splitUsfmLead("\\s1 Title\n\\p\nWords")).toEqual({
      blocks: [{ marker: "s1", text: "Title" }, { marker: "p", text: "" }],
      body: "Words",
    })
  })
})
