import { describe, it, expect } from "vitest"
import { spliceFootnoteText } from "./splice"
import { extractUsfmFootnotes } from "./extract"

describe("spliceFootnoteText", () => {
  it("replaces \\ft content in an existing footnote", () => {
    const text = "verse \\f + \\fr 1:1 \\ft original note\\f* end"
    const result = spliceFootnoteText(text, 0, "translated note")
    expect(result).toBe("verse \\f + \\fr 1:1 \\ft translated note\\f* end")
  })

  it("appends \\ft field when no \\ft exists", () => {
    const text = "verse \\f + \\fr 1:1 \\f* end"
    const result = spliceFootnoteText(text, 0, "new note")
    expect(result).toBe("verse \\f + \\fr 1:1 \\ft new note\\f* end")
  })

  it("only replaces the targeted footnote index (second of two)", () => {
    const text = "a \\f + \\fr 1:1 \\ft note one\\f* b \\f + \\fr 1:2 \\ft note two\\f* c"
    const result = spliceFootnoteText(text, 1, "translated two")
    expect(result).toBe("a \\f + \\fr 1:1 \\ft note one\\f* b \\f + \\fr 1:2 \\ft translated two\\f* c")
  })

  it("preserves surrounding verse text unchanged", () => {
    const original = "In the beginning \\f + \\fr 1:1 \\ft note\\f* God created"
    const result = spliceFootnoteText(original, 0, "updated note")
    expect(result).toBe("In the beginning \\f + \\fr 1:1 \\ft updated note\\f* God created")
    // Flanking text untouched
    expect(result.startsWith("In the beginning ")).toBe(true)
    expect(result.endsWith(" God created")).toBe(true)
  })

  it("preserves \\fr field when replacing \\ft", () => {
    const text = "verse \\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*"
    const result = spliceFootnoteText(text, 0, "(Rut 4:19,20)")
    expect(result).toContain("\\fr 1:4")
    expect(result).toContain("\\ft (Rut 4:19,20)")
  })

  it("round-trips: re-extracting after splice gives updated text", () => {
    const text = "verse \\f + \\fr 1:1 \\ft original\\f*"
    const spliced = spliceFootnoteText(text, 0, "translated")
    const footnotes = extractUsfmFootnotes(spliced)
    expect(footnotes[0].text).toBe("translated")
  })

  it("returns original text when footnoteIndex is out of range", () => {
    const text = "verse \\f + \\fr 1:1 \\ft note\\f*"
    expect(spliceFootnoteText(text, 5, "x")).toBe(text)
  })

  it("returns original text when no footnotes present", () => {
    const text = "plain verse"
    expect(spliceFootnoteText(text, 0, "x")).toBe(text)
  })
})
