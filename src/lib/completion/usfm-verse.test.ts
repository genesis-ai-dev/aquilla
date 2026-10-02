import { describe, expect, it } from "vitest"
import { extractChapterText, extractVerseText, stripUsfmMarkup } from "./usfm-verse"

const ISA = [
  "\\id ISA",
  "\\c 39",
  "\\v 8 Then said Hezekiah, Good is the word of the LORD.",
  "\\c 40",
  "\\p",
  "\\v 24 Yea, they shall not be planted.",
  "\\v 25 To whom then will ye liken me, or shall I be equal? saith the Holy One.",
  "\\v 26 Lift up your eyes on high, and behold who hath created these things.",
  "\\c 41",
  "\\v 1 Keep silence before me, O islands.",
].join("\n")

describe("extractVerseText (AQU-1573)", () => {
  it("returns exactly the cited verse, not its neighbours or its chapter", () => {
    expect(extractVerseText({ usfm: ISA, chapter: 40, verseStart: 25 })).toBe(
      "To whom then will ye liken me, or shall I be equal? saith the Holy One.",
    )
  })

  it("joins a verse range in document order", () => {
    expect(extractVerseText({ usfm: ISA, chapter: 40, verseStart: 25, verseEnd: 26 })).toBe(
      "To whom then will ye liken me, or shall I be equal? saith the Holy One. "
        + "Lift up your eyes on high, and behold who hath created these things.",
    )
  })

  it("does not take a verse from the wrong chapter when both carry its number", () => {
    expect(extractVerseText({ usfm: ISA, chapter: 41, verseStart: 1 })).toBe(
      "Keep silence before me, O islands.",
    )
    expect(extractVerseText({ usfm: ISA, chapter: 39, verseStart: 25 })).toBeNull()
  })

  it("returns null for a chapter or verse the version does not carry", () => {
    expect(extractVerseText({ usfm: ISA, chapter: 99, verseStart: 1 })).toBeNull()
    expect(extractVerseText({ usfm: ISA, chapter: 40, verseStart: 99 })).toBeNull()
    expect(extractVerseText({ usfm: "", chapter: 40, verseStart: 25 })).toBeNull()
  })

  it("reads a partial-verse marker as its verse — a citation never names the letter", () => {
    const usfm = "\\c 1\n\\v 1a In the beginning\n\\v 1b God created."
    expect(extractVerseText({ usfm, chapter: 1, verseStart: 1 })).toBe("In the beginning God created.")
  })

  it("serves either half of a bridged verse from the bridge, once", () => {
    const usfm = "\\c 1\n\\v 25-26 Bridged text.\n\\v 27 After."
    expect(extractVerseText({ usfm, chapter: 1, verseStart: 25 })).toBe("Bridged text.")
    expect(extractVerseText({ usfm, chapter: 1, verseStart: 26 })).toBe("Bridged text.")
    expect(extractVerseText({ usfm, chapter: 1, verseStart: 25, verseEnd: 26 })).toBe("Bridged text.")
  })

  it("refuses nonsense coordinates", () => {
    expect(extractVerseText({ usfm: ISA, chapter: 0, verseStart: 1 })).toBeNull()
    expect(extractVerseText({ usfm: ISA, chapter: 40, verseStart: 0 })).toBeNull()
  })
})

describe("stripUsfmMarkup", () => {
  it("keeps the content of character markers and drops the markers", () => {
    expect(stripUsfmMarkup("\\nd LORD\\nd* is my shepherd")).toBe("LORD is my shepherd")
    expect(stripUsfmMarkup("\\wj Come to me\\wj*")).toBe("Come to me")
  })

  it("drops footnotes and cross-references WITH their content — they are not reading text", () => {
    expect(stripUsfmMarkup("Jesus wept.\\f + \\ft Some manuscripts omit.\\f* Then he rose.")).toBe(
      "Jesus wept. Then he rose.",
    )
    expect(stripUsfmMarkup("the Word\\x - \\xo 1.1 \\xt Gen 1:1\\x* was God")).toBe("the Word was God")
  })

  it("drops alignment milestones and word attributes", () => {
    expect(stripUsfmMarkup("\\zaln-s |x-strong=\"H0430\"\\*\\w God|lemma=\"God\"\\w*\\zaln-e\\* said")).toBe(
      "God said",
    )
  })

  it("collapses whitespace, including the non-breaking kind", () => {
    expect(stripUsfmMarkup("  two \n lines   here ")).toBe("two lines here")
  })
})

describe("extractChapterText", () => {
  it("returns a chapter's own slice and null for one the book lacks", () => {
    expect(extractChapterText(ISA, 41)).toContain("Keep silence")
    expect(extractChapterText(ISA, 41)).not.toContain("liken me")
    expect(extractChapterText(ISA, 99)).toBeNull()
  })
})
