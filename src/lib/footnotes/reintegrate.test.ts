import { describe, it, expect } from "vitest"
import { prepareFootnotesForPrompt } from "./completion"
import { extractUsfmFootnotes } from "./extract"
import { createUsfmFootnoteMarker } from "./insert"
import { reintegrateFootnotes } from "./reintegrate"

const noteMarker = createUsfmFootnoteMarker({ text: "source note" })

describe("reintegrateFootnotes", () => {
  it("splices a translated [n] line back into a real \\f...\\f* marker at the caller position", () => {
    const notes = extractUsfmFootnotes(`Base${noteMarker} text.`)
    const out = reintegrateFootnotes("Translated base [1] rest.\n[1] translated note", notes)
    expect(out.text).toBe("Translated base \\f + \\ft translated note\\f* rest.")
    expect(out.missingNoteLines).toEqual([])
    expect(out.appendedCallers).toEqual([])
  })

  it("preserves the source note's caller and \\fr reference scaffolding", () => {
    const notes = extractUsfmFootnotes("X\\f a \\fr 1:1 \\ft old note\\f* Y")
    const out = reintegrateFootnotes("A [1] B\n[1] new note", notes)
    expect(out.text).toBe("A \\f a \\fr 1:1 \\ft new note\\f* B")
  })

  it("handles multiple footnotes with [n] lines in any order", () => {
    const src = `One${createUsfmFootnoteMarker({ text: "first" })} two${createUsfmFootnoteMarker({ text: "second" })}.`
    const notes = extractUsfmFootnotes(src)
    const out = reintegrateFootnotes("Uno [1] dos [2].\n[2] segunda\n[1] primera", notes)
    expect(out.text).toBe("Uno \\f + \\ft primera\\f* dos \\f + \\ft segunda\\f*.")
    expect(out.missingNoteLines).toEqual([])
  })

  it("falls back to the source note text when the model omits an [n] line", () => {
    const src = `A${createUsfmFootnoteMarker({ text: "first" })} B${createUsfmFootnoteMarker({ text: "second" })}`
    const notes = extractUsfmFootnotes(src)
    const out = reintegrateFootnotes("tA [1] tB [2]\n[1] tFirst", notes)
    expect(out.text).toBe("tA \\f + \\ft tFirst\\f* tB \\f + \\ft second\\f*")
    expect(out.missingNoteLines).toEqual([2])
    expect(out.appendedCallers).toEqual([])
  })

  it("appends the marker when the model dropped the caller from the base", () => {
    const notes = extractUsfmFootnotes(`Base${noteMarker}.`)
    const out = reintegrateFootnotes("Translated base only.\n[1] translated note", notes)
    expect(out.text).toBe("Translated base only. \\f + \\ft translated note\\f*")
    expect(out.appendedCallers).toEqual([1])
  })

  it("keeps a bare [1] base for a footnote-only cell instead of eating it as a note line", () => {
    const notes = extractUsfmFootnotes(noteMarker)
    const out = reintegrateFootnotes("[1]\n[1] translated note", notes)
    expect(out.text).toBe("\\f + \\ft translated note\\f*")
    expect(out.missingNoteLines).toEqual([])
  })

  it("returns null text when the model emitted only [n] lines and no base", () => {
    const notes = extractUsfmFootnotes(`Base${noteMarker}.`)
    const out = reintegrateFootnotes("[1] translated note", notes)
    expect(out.text).toBeNull()
  })

  it("returns null text for empty or whitespace-only output", () => {
    const notes = extractUsfmFootnotes(`Base${noteMarker}.`)
    expect(reintegrateFootnotes("", notes).text).toBeNull()
    expect(reintegrateFootnotes("  \n ", notes).text).toBeNull()
  })

  it("strips an echoed (ref) from the footnote line", () => {
    const notes = extractUsfmFootnotes("X\\f + \\fr 1:1 \\ft old\\f* Y")
    const out = reintegrateFootnotes("A [1] B\n[1] (1:1) new note", notes)
    expect(out.text).toBe("A \\f + \\fr 1:1 \\ft new note\\f* B")
  })

  it("strips a repeated caller and leaves out-of-range bracket tokens untouched", () => {
    const notes = extractUsfmFootnotes(`Base${noteMarker}.`)
    const out = reintegrateFootnotes("A [1] B [1] C [7].\n[1] note tr", notes)
    expect(out.text).toBe("A \\f + \\ft note tr\\f* B C [7].")
  })

  it("keeps duplicate [n] reply lines resolved to the occurrence closest to the base", () => {
    const notes = extractUsfmFootnotes(`Base${noteMarker}.`)
    const out = reintegrateFootnotes("tBase [1].\n[1] first emitted\n[1] second emitted", notes)
    expect(out.text).toBe("tBase \\f + \\ft first emitted\\f*.")
  })

  it("sanitizes marker-breaking backslashes out of model note text", () => {
    const notes = extractUsfmFootnotes(`Base${noteMarker}.`)
    const out = reintegrateFootnotes("tBase [1].\n[1] bad \\f* note here", notes)
    expect(out.text).toBe("tBase \\f + \\ft bad note here\\f*.")
    // Still one parseable footnote.
    expect(extractUsfmFootnotes(out.text ?? "")).toHaveLength(1)
  })

  // Round-trip composition (AGENTS.md rule 12): prepare → a well-behaved
  // model reply → reintegrate must yield text whose footnotes re-extract with
  // the same count, callers, and refs as the source.
  it("round-trips prepare → model reply → reintegrate → extract", () => {
    const src =
      `Alpha\\f a \\fr 1:2 \\ft first note\\f* beta` +
      `${createUsfmFootnoteMarker({ text: "second note" })} gamma.`
    const srcNotes = extractUsfmFootnotes(src)
    const prepared = prepareFootnotesForPrompt(src)
    // Simulate a model that translates by uppercasing and follows the contract
    // (uppercasing leaves the [n] markers intact).
    const reply = prepared.promptSource.toUpperCase() + "\n[1] FIRST NOTE\n[2] SECOND NOTE"
    const out = reintegrateFootnotes(reply, prepared.notes)
    expect(out.text).not.toBeNull()
    expect(out.missingNoteLines).toEqual([])
    expect(out.appendedCallers).toEqual([])
    const roundTripped = extractUsfmFootnotes(out.text ?? "")
    expect(roundTripped).toHaveLength(srcNotes.length)
    expect(roundTripped.map((n) => n.caller)).toEqual(srcNotes.map((n) => n.caller))
    expect(roundTripped.map((n) => n.ref)).toEqual(srcNotes.map((n) => n.ref))
    expect(roundTripped.map((n) => n.text)).toEqual(["FIRST NOTE", "SECOND NOTE"])
    expect(out.text).not.toContain("[1]")
    expect(out.text).not.toContain("[2]")
  })
})
