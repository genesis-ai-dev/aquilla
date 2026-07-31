import { describe, expect, it } from "vitest"
import {
  bookCodeFromParagraphText,
  computeChapterRangeLabel,
  isBiblicaBookMarkerStyle,
  isBiblicaChapterHeadingStyle,
  isBiblicaNoteSectionStyle,
  isChapterNumberCharacterStyle,
  isMetaChapterCharacterStyle,
  isMetaVerseCharacterStyle,
  isSourceSerifCharacterStyle,
  isStructuralApostropheContent,
  isStructuralApostropheSegment,
  isStructuralOnlyContent,
  isVerseNumberCharacterStyle,
} from "./note-rules"

describe("Biblica IDML style rules", () => {
  it("recognizes note, book-marker, and chapter-heading paragraph styles in both colon forms", () => {
    for (const style of ["ParagraphStyle/intro%3aip", "ParagraphStyle/intro:ipi"]) {
      expect(isBiblicaNoteSectionStyle(style)).toBe(true)
    }
    expect(isBiblicaNoteSectionStyle("ParagraphStyle/cv%3ap")).toBe(false)
    expect(isBiblicaNoteSectionStyle("ParagraphStyle/meta%3arh")).toBe(false)

    expect(isBiblicaBookMarkerStyle("ParagraphStyle/meta%3abk")).toBe(true)
    expect(isBiblicaBookMarkerStyle("ParagraphStyle/meta:bk")).toBe(true)
    expect(isBiblicaBookMarkerStyle("ParagraphStyle/meta%3arh")).toBe(false)

    expect(isBiblicaChapterHeadingStyle("ParagraphStyle/intro%3ahead%3acl")).toBe(true)
    expect(isBiblicaChapterHeadingStyle("ParagraphStyle/intro%3ad_h")).toBe(false)
  })

  it("keeps verse, chapter, and bookend character styles distinct", () => {
    expect(isVerseNumberCharacterStyle("CharacterStyle/cv%3av1")).toBe(true)
    expect(isVerseNumberCharacterStyle("CharacterStyle/cv:v")).toBe(true)
    // A drop-cap chapter number must never be read as a verse number.
    expect(isVerseNumberCharacterStyle("CharacterStyle/cv%3adc")).toBe(false)
    expect(isChapterNumberCharacterStyle("CharacterStyle/cv%3adc")).toBe(true)

    expect(isMetaVerseCharacterStyle("CharacterStyle/meta%3av")).toBe(true)
    expect(isMetaChapterCharacterStyle("CharacterStyle/meta%3ac")).toBe(true)
    expect(isMetaChapterCharacterStyle("CharacterStyle/meta%3av")).toBe(false)
    expect(isMetaVerseCharacterStyle("CharacterStyle/meta%3ac")).toBe(false)
  })

  it("treats source-serif runs and apostrophe-only text as structural glue", () => {
    expect(isSourceSerifCharacterStyle("CharacterStyle/Source Serif Pro")).toBe(true)
    expect(isSourceSerifCharacterStyle("CharacterStyle/source serif")).toBe(true)
    expect(isSourceSerifCharacterStyle("CharacterStyle/Minion")).toBe(false)

    for (const apostrophe of ["'", "\u02BC", "\u2019", "\u2032", "\u00B4"]) {
      expect(isStructuralApostropheContent(apostrophe)).toBe(true)
    }
    expect(isStructuralApostropheContent("Zmluvné")).toBe(false)
    expect(isStructuralApostropheContent("")).toBe(false)

    // Real words in a source-serif run are still glue; apostrophes are glue in
    // any style.
    expect(isStructuralApostropheSegment("dejiny", "CharacterStyle/Source Serif")).toBe(true)
    expect(isStructuralApostropheSegment("\u2019", "CharacterStyle/Minion")).toBe(true)
    expect(isStructuralApostropheSegment("dejiny", "CharacterStyle/Minion")).toBe(false)
  })

  it("detects paragraphs whose only content is ACE markers or whitespace", () => {
    expect(isStructuralOnlyContent(["<?ACE 3?>", "  ", "\n"])).toBe(true)
    expect(isStructuralOnlyContent([])).toBe(true)
    expect(isStructuralOnlyContent(["<?ACE 3?>", " Genesis"])).toBe(false)
  })

  it("reads a book code from an inline book heading only for real book codes", () => {
    expect(bookCodeFromParagraphText("GEN — Genesis")).toBe("GEN")
    expect(bookCodeFromParagraphText("1SA - First Samuel")).toBe("1SA")
    expect(bookCodeFromParagraphText("PSA\nPsalms")).toBe("PSA")
    expect(bookCodeFromParagraphText("XYZ — Not a book")).toBeUndefined()
    expect(bookCodeFromParagraphText("Genesis 1:1")).toBeUndefined()
  })

  it("labels a note section by the chapter range scanned before it", () => {
    expect(computeChapterRangeLabel(null, null, false)).toBe("Preface")
    // Verses seen, but none since the last note section.
    expect(computeChapterRangeLabel(null, null, true)).toBe("Preface")
    expect(computeChapterRangeLabel("3", "3", true)).toBe("3")
    expect(computeChapterRangeLabel("3", null, true)).toBe("3")
    expect(computeChapterRangeLabel("1", "2", true)).toBe("1-2")
  })
})
