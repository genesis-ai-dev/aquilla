import { describe, it, expect } from "vitest"
import { extractUsfmFootnotes, hasUsfmFootnotes } from "./extract"

describe("extractUsfmFootnotes", () => {
  it("returns empty array when no footnotes present", () => {
    expect(extractUsfmFootnotes("plain verse text")).toEqual([])
    expect(extractUsfmFootnotes("")).toEqual([])
  })

  it("extracts a single simple footnote", () => {
    const text = "In the beginning \\f + \\fr 1:1 \\ft Some note\\f* God created"
    const footnotes = extractUsfmFootnotes(text)
    expect(footnotes).toHaveLength(1)
    expect(footnotes[0].caller).toBe("+")
    expect(footnotes[0].ref).toBe("1:1")
    expect(footnotes[0].text).toBe("Some note")
  })

  it("extracts footnotes from a real USFM sample (Ruth 4:19-20 pattern)", () => {
    const text = "...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*"
    const footnotes = extractUsfmFootnotes(text)
    expect(footnotes).toHaveLength(1)
    expect(footnotes[0].caller).toBe("+")
    expect(footnotes[0].ref).toBe("1:4")
    expect(footnotes[0].text).toBe("(Ruth 4:19,20)")
    // raw must be the full original span — round-trip check
    expect(footnotes[0].raw).toBe("\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*")
  })

  it("extracts multiple footnotes from one verse", () => {
    const text = "word \\f + \\fr 1:1 \\ft first note\\f* more \\f - \\fr 1:2 \\ft second note\\f*"
    const footnotes = extractUsfmFootnotes(text)
    expect(footnotes).toHaveLength(2)
    expect(footnotes[0].text).toBe("first note")
    expect(footnotes[1].text).toBe("second note")
    expect(footnotes[1].caller).toBe("-")
  })

  it("handles footnotes without \\fr (ref-less)", () => {
    const text = "verse \\f + \\ft A simple note\\f*"
    const footnotes = extractUsfmFootnotes(text)
    expect(footnotes).toHaveLength(1)
    expect(footnotes[0].ref).toBe("")
    expect(footnotes[0].text).toBe("A simple note")
  })

  it("collects \\fq and \\fqa fields into text", () => {
    const text = "verse \\f + \\fr 2:3 \\fq Alt quote \\fqa another alt\\f*"
    const footnotes = extractUsfmFootnotes(text)
    expect(footnotes[0].text).toBe("Alt quote another alt")
  })

  it("preserves raw span byte-for-byte for round-trip verification", () => {
    const original = "\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*"
    const text = `verse text ${original} more text`
    const footnotes = extractUsfmFootnotes(text)
    expect(footnotes[0].raw).toBe(original)
  })

  it("returns index pointing to start of \\f in the text", () => {
    const prefix = "some prefix "
    const footnote = "\\f + \\fr 1:1 \\ft note\\f*"
    const text = prefix + footnote
    const footnotes = extractUsfmFootnotes(text)
    expect(footnotes[0].index).toBe(prefix.length)
  })
})

describe("hasUsfmFootnotes", () => {
  it("returns true for text with \\f markers", () => {
    expect(hasUsfmFootnotes("text \\f + \\fr 1:1 \\ft note\\f*")).toBe(true)
  })

  it("returns false for plain text", () => {
    expect(hasUsfmFootnotes("plain text")).toBe(false)
  })
})
