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
    const result = spliceFootnoteText(original, 0, "updated note")!
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
    const spliced = spliceFootnoteText(text, 0, "translated")!
    const footnotes = extractUsfmFootnotes(spliced)
    expect(footnotes[0].text).toBe("translated")
  })

  it("returns null when footnoteIndex is out of range (FRO-472: callers must surface the failure)", () => {
    const text = "verse \\f + \\fr 1:1 \\ft note\\f*"
    expect(spliceFootnoteText(text, 5, "x")).toBeNull()
  })

  it("returns null when no footnotes present", () => {
    const text = "plain verse"
    expect(spliceFootnoteText(text, 0, "x")).toBeNull()
  })

  // FRO-472 regression: the draft the edit UI hands back is the concatenation
  // of ALL translatable fields (extract.ts), so the splice must replace the
  // entire field region — replacing only the first \ft run duplicated the
  // remaining fields' text, compounding on every save.
  describe("multi-field and nested-marker notes (FRO-472)", () => {
    it("replaces the whole field region of a \\ft + \\fq note", () => {
      const text = "verse \\f + \\fr 1:1 \\ft a \\fq quote\\f* end"
      const result = spliceFootnoteText(text, 0, "a quote")
      expect(result).toBe("verse \\f + \\fr 1:1 \\ft a quote\\f* end")
    })

    it("saving the extracted draft unchanged is a no-op round-trip (\\fq)", () => {
      const text = "verse \\f + \\fr 1:1 \\ft a \\fq quote\\f* end"
      const draft = extractUsfmFootnotes(text)[0].text
      const once = spliceFootnoteText(text, 0, draft)!
      const twice = spliceFootnoteText(once, 0, extractUsfmFootnotes(once)[0].text)
      expect(extractUsfmFootnotes(once)[0].text).toBe(draft)
      expect(twice).toBe(once)
    })

    it("does not duplicate nested character markers (\\bd...\\bd*)", () => {
      const text = "verse \\f + \\fr 1:1 \\ft a \\bd bold\\bd* tail\\f* end"
      const draft = extractUsfmFootnotes(text)[0].text
      const once = spliceFootnoteText(text, 0, draft)!
      expect(once).toBe(text)
      const twice = spliceFootnoteText(once, 0, extractUsfmFootnotes(once)[0].text)
      expect(twice).toBe(once)
    })

    it("handles a note whose first field is \\fq (no \\ft)", () => {
      const text = "verse \\f + \\fr 1:1 \\fq only a quote\\f* end"
      const result = spliceFootnoteText(text, 0, "translated quote")
      expect(result).toBe("verse \\f + \\fr 1:1 \\ft translated quote\\f* end")
    })

    it("handles \\fqa without half-matching it as \\fq", () => {
      const text = "verse \\f + \\fr 1:1 \\fqa alt quote\\f* end"
      const result = spliceFootnoteText(text, 0, "new alt")
      expect(result).toBe("verse \\f + \\fr 1:1 \\ft new alt\\f* end")
    })

    it("replaces \\ft + \\fk + \\fl multi-field notes wholesale", () => {
      const text = "v \\f + \\fr 2:3 \\ft note \\fk keyword \\fl label\\f* w"
      const result = spliceFootnoteText(text, 0, "note keyword label")
      expect(result).toBe("v \\f + \\fr 2:3 \\ft note keyword label\\f* w")
    })

    it("targets the correct footnote when a multi-field note follows a simple one", () => {
      const text = "a \\f + \\fr 1:1 \\ft one\\f* b \\f + \\fr 1:2 \\ft two \\fq quoted\\f* c"
      const result = spliceFootnoteText(text, 1, "two quoted")
      expect(result).toBe("a \\f + \\fr 1:1 \\ft one\\f* b \\f + \\fr 1:2 \\ft two quoted\\f* c")
    })
  })
})
