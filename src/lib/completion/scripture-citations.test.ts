import { describe, expect, it } from "vitest"
import { MAX_CITATIONS_PER_CELL, citationLabel, findScriptureCitations } from "./scripture-citations"

describe("findScriptureCitations (AQU-1573)", () => {
  it("finds the ticket's own citation in running prose", () => {
    const found = findScriptureCitations('Chip asks, as Isaiah 40:25 does, "To whom will you compare me?"')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      bookCode: "ISA",
      chapter: 40,
      verseStart: 25,
      verseEnd: 25,
      canonicalRef: "ISA 40:25",
      matchedText: "Isaiah 40:25",
    })
  })

  it("reads an abbreviated, parenthesised, numbered citation with a verse range", () => {
    const found = findScriptureCitations("Love is patient (1 Cor. 13:4-7), and that is the whole sermon.")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      bookCode: "1CO",
      chapter: 13,
      verseStart: 4,
      verseEnd: 7,
      canonicalRef: "1CO 13:4",
    })
    expect(citationLabel(found[0])).toBe("1 Cor. 13:4-7")
  })

  it("keeps the Gospel and the epistles of John apart", () => {
    expect(findScriptureCitations("John 3:16")[0]?.bookCode).toBe("JHN")
    expect(findScriptureCitations("1 John 4:8")[0]?.bookCode).toBe("1JN")
    expect(findScriptureCitations("3 John 1:4")[0]?.bookCode).toBe("3JN")
  })

  it("accepts roman and spelled ordinals, and a USFM code", () => {
    expect(findScriptureCitations("II Timothy 3:16")[0]?.bookCode).toBe("2TI")
    expect(findScriptureCitations("Second Peter 1:4")[0]?.bookCode).toBe("2PE")
    expect(findScriptureCitations("ISA 40:25")[0]?.canonicalRef).toBe("ISA 40:25")
  })

  it("finds several citations in one cell, in order of appearance", () => {
    const found = findScriptureCitations(
      "Romans 8:28 answers the fear that Psalm 23:4 names, and Hebrews 11:1 defines the faith.",
    )
    expect(found.map((c) => c.canonicalRef)).toEqual(["ROM 8:28", "PSA 23:4", "HEB 11:1"])
  })

  it("collapses a repeated citation to one entry — the verse is injected once", () => {
    const found = findScriptureCitations("Isaiah 40:25 asks it; Isaiah 40:25 answers it.")
    expect(found).toHaveLength(1)
    expect(found[0].index).toBe(0)
  })

  // A false positive injects an unrelated verse into the prompt as something to
  // reproduce verbatim, so every one of these must yield nothing.
  it("requires an explicit chapter:verse", () => {
    expect(findScriptureCitations("Isaiah is the prophet of comfort.")).toEqual([])
    expect(findScriptureCitations("Read Isaiah 40 this week.")).toEqual([])
  })

  it("refuses a numbered book with no ordinal rather than guessing which one", () => {
    expect(findScriptureCitations("Corinthians 13:4 is the famous one.")).toEqual([])
    expect(findScriptureCitations("Kings 2:3 says so.")).toEqual([])
  })

  it("refuses an ordinal on a book that has none", () => {
    expect(findScriptureCitations("2 Isaiah 40:25")).toEqual([])
  })

  it("ignores words that merely look like book names, and bare numbers", () => {
    expect(findScriptureCitations("Session 3:15 of the curriculum")).toEqual([])
    expect(findScriptureCitations("the ratio is 40:25")).toEqual([])
  })

  it("does not read a three-part version string as a citation", () => {
    expect(findScriptureCitations("Isaiah 40:25:3")).toEqual([])
  })

  it("drops a backwards range rather than inverting it", () => {
    expect(findScriptureCitations("Isaiah 40:25-20")).toEqual([])
  })

  it("handles the non-breaking space copy-pasted prose is full of", () => {
    expect(findScriptureCitations("Isaiah 40:25")[0]?.canonicalRef).toBe("ISA 40:25")
  })

  it("caps citations per cell, and honours a caller's lower limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => `Romans ${i + 1}:1`).join(" ")
    expect(findScriptureCitations(many)).toHaveLength(MAX_CITATIONS_PER_CELL)
    expect(findScriptureCitations(many, { limit: 2 })).toHaveLength(2)
    expect(findScriptureCitations(many, { limit: 0 })).toEqual([])
  })

  it("is safe on empty and absent input", () => {
    expect(findScriptureCitations("")).toEqual([])
    expect(findScriptureCitations(null)).toEqual([])
    expect(findScriptureCitations(undefined)).toEqual([])
  })

  it("does not carry regex state between calls", () => {
    const text = "Isaiah 40:25"
    expect(findScriptureCitations(text)).toHaveLength(1)
    expect(findScriptureCitations(text)).toHaveLength(1)
  })
})
