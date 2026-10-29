import { describe, it, expect } from "vitest"
import { insertFootnoteMarkerAtAnchor, spliceFootnoteText } from "./splice"
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

// AQU-2206: the Add Footnote dialog previews the marker right after the anchored
// phrase, then the row commits the stored text itself because the dialog's text
// field pulled focus out of the cell and unmounted the editor. That commit used
// to APPEND the marker, so every footnote added this way landed at the end of
// the cell and the preview was a lie.
describe("insertFootnoteMarkerAtAnchor", () => {
  const MARKER = "\\f + \\fr 1:3 \\ft luz: note\\f*"

  it("splices the marker where the preview showed it, not at the end of the cell", () => {
    const cell = "Y dijo Dios: Sea la luz; y fue la luz."
    const result = insertFootnoteMarkerAtAnchor(cell, MARKER, {
      previewBefore: "Y dijo Dios: Sea la luz",
    })
    expect(result).toBe(`Y dijo Dios: Sea la luz${MARKER}; y fue la luz.`)
  })

  it("reproduces the preview exactly: previewBefore + marker + previewAfter", () => {
    const previewBefore = "Y dijo Dios: Sea la luz"
    const previewAfter = "; y fue la luz."
    const result = insertFootnoteMarkerAtAnchor(previewBefore + previewAfter, MARKER, { previewBefore })
    expect(result).toBe(`${previewBefore}${MARKER}${previewAfter}`)
  })

  it("appends when there is no anchor (the row reached by hover alone)", () => {
    const cell = "Y dijo Dios: Sea la luz."
    expect(insertFootnoteMarkerAtAnchor(cell, MARKER, null)).toBe(`${cell}${MARKER}`)
    expect(insertFootnoteMarkerAtAnchor(cell, MARKER, undefined)).toBe(`${cell}${MARKER}`)
    expect(insertFootnoteMarkerAtAnchor(cell, MARKER, {})).toBe(`${cell}${MARKER}`)
  })

  it("appends for an end-of-cell anchor, whose preview is the whole cell", () => {
    const cell = "Y dijo Dios: Sea la luz."
    const result = insertFootnoteMarkerAtAnchor(cell, MARKER, { previewBefore: cell })
    expect(result).toBe(`${cell}${MARKER}`)
  })

  it("inserts at the very start when the anchor sits before the first character", () => {
    const cell = "Y dijo Dios."
    expect(insertFootnoteMarkerAtAnchor(cell, MARKER, { previewBefore: "" })).toBe(`${MARKER}${cell}`)
  })

  it("keeps an existing footnote whole and parseable when adding a second one", () => {
    const first = "\\f + \\fr 1:3 \\ft first note\\f*"
    const cell = `Y dijo Dios${first}: Sea la luz; y fue la luz.`
    const result = insertFootnoteMarkerAtAnchor(cell, MARKER, {
      previewBefore: `Y dijo Dios${first}: Sea la luz`,
    })
    const footnotes = extractUsfmFootnotes(result)
    expect(footnotes).toHaveLength(2)
    expect(footnotes[0].text).toBe("first note")
    expect(footnotes[1].text).toBe("luz: note")
    // Document order, so the chapter numbering stays 1, 2.
    expect(footnotes[0].index).toBeLessThan(footnotes[1].index)
  })

  it("never splices inside an existing \\f...\\f* span — it lands past the note", () => {
    const first = "\\f + \\fr 1:3 \\ft first note\\f*"
    const cell = `Dios${first} dijo`
    // An offset that falls in the middle of the existing marker's raw text.
    const result = insertFootnoteMarkerAtAnchor(cell, MARKER, {
      previewBefore: `Dios${first.slice(0, 10)}`,
    })
    expect(result).toBe(`Dios${first}${MARKER} dijo`)
    expect(extractUsfmFootnotes(result)).toHaveLength(2)
  })

  it("falls back to appending when the cell changed under the open dialog", () => {
    // A remote edit landed between opening the dialog and pressing Add, so the
    // previewed prefix no longer describes this text. Appending is wrong by the
    // old amount; splicing at a stale offset would corrupt the other edit.
    const cell = "Y dijo Dios: Hubo luz; y fue la luz."
    const result = insertFootnoteMarkerAtAnchor(cell, MARKER, {
      previewBefore: "Y dijo Dios: Sea la luz",
    })
    expect(result).toBe(`${cell}${MARKER}`)
  })
})
