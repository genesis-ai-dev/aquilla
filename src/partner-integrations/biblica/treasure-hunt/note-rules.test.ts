import { describe, expect, it } from "vitest"
import {
  classifyTreasureHuntUnit,
  isRunningHeadGlyph,
  isTreasureHuntBlockHeadStyle,
  isTreasureHuntBookNameStyle,
  parseTreasureHuntReference,
  treasureHuntChapterLabel,
} from "./note-rules"

describe("Treasure Hunt paragraph classification", () => {
  it("treats every published-text style as scripture", () => {
    // Sampled from the ten shipped volumes, which between them use over 190
    // scripture styles — the shared shape is `p` + an uppercase letter.
    for (const style of [
      "pNormal",
      "pStanzaLine1",
      "pStanzaLine1FirstInStanza",
      "pSectionHead",
      "pMinorSectionHead",
      "pTitleMain",
      "pPsalmDescription",
      "pPsalmNumber",
      "pAcrosticStanzaLine2Psalm119",
      "pSubListElaborationOfConclusion",
      "pEmbeddedNormalFirstInEmbedded",
      "CHAP1pNormalAfterSectionHead",
      "CHAP2pMinorSectionNormalAfterMinorSectionHead",
      "*pNormal*",
    ]) {
      expect(classifyTreasureHuntUnit(style)).toBe("scripture")
    }
  })

  it("treats page numbers, running heads and proof stamps as furniture", () => {
    for (const style of [
      "#pn",
      "#rh_recto",
      "#rh_verso",
      "zz.proof stages",
      "*DEFAULT PARAGRAPH*",
      "$ID/[No paragraph style]",
    ]) {
      expect(classifyTreasureHuntUnit(style)).toBe("furniture")
    }
  })

  it("treats the apparatus, the introductions and the front matter as content", () => {
    for (const style of [
      "!meta_par",
      "!meta_par_ns",
      "!meta_fact_head",
      "!meta_hunt_head",
      "!meta_hunt_list",
      "!hunt_par_tab",
      "!fact_list",
      "_intro_head",
      "_intro_book",
      "_intro_book_long",
      "_intro_section",
      "_intro_list_lv1",
      "par",
      "par_next",
      "par_head",
      "fm_title",
      "fm_title_sub",
      "toc_l1",
      "map_site_name",
      "sign.book",
      "wayees",
      "bul",
      "$ID/NormalParagraphStyle",
    ]) {
      expect(classifyTreasureHuntUnit(style)).toBe("content")
    }
  })

  it("classifies a style by its name, however InDesign wrote the path", () => {
    // The engine reports the applied style as InDesign stores it, and encodes
    // characters that are illegal in that path.
    expect(classifyTreasureHuntUnit("ParagraphStyle/!meta_par")).toBe("content")
    expect(classifyTreasureHuntUnit("ParagraphStyle/%21meta_par")).toBe("content")
    expect(classifyTreasureHuntUnit("ParagraphStyle/pStanzaLine1")).toBe("scripture")
    expect(classifyTreasureHuntUnit("ParagraphStyle/%23pn")).toBe("furniture")
    expect(classifyTreasureHuntUnit("ParagraphStyle/$ID/[No paragraph style]")).toBe("furniture")
  })

  it("takes an unknown style as content, so a new note style is never dropped", () => {
    expect(classifyTreasureHuntUnit("!meta_something_new")).toBe("content")
    expect(classifyTreasureHuntUnit("quiz_answer_key")).toBe("content")
  })

  it("recognises the reference heading that opens a fact or hunt block", () => {
    expect(isTreasureHuntBlockHeadStyle("!meta_fact_head")).toBe(true)
    expect(isTreasureHuntBlockHeadStyle("!meta_hunt_head")).toBe(true)
    expect(isTreasureHuntBlockHeadStyle("!fact_head")).toBe(true)
    expect(isTreasureHuntBlockHeadStyle("!meta_par")).toBe(false)
    // `_intro_head` names a topic ("What is this book about?"), not a passage.
    expect(isTreasureHuntBlockHeadStyle("_intro_head")).toBe(false)
    expect(isTreasureHuntBlockHeadStyle("pSectionHead")).toBe(false)
  })

  it("recognises the paragraph naming the book an introduction belongs to", () => {
    expect(isTreasureHuntBookNameStyle("_intro_book")).toBe(true)
    expect(isTreasureHuntBookNameStyle("_intro_book_long")).toBe(true)
    expect(isTreasureHuntBookNameStyle("_intro_section")).toBe(false)
    expect(isTreasureHuntBookNameStyle("pTitleMain")).toBe(false)
  })

  it("recognises a running-head frame by the separator glyph it holds", () => {
    expect(isRunningHeadGlyph("|")).toBe(true)
    expect(isRunningHeadGlyph(" | ")).toBe(true)
    expect(isRunningHeadGlyph("<?ACE 18?> |")).toBe(true)
    expect(isRunningHeadGlyph("| PSALM")).toBe(false)
    expect(isRunningHeadGlyph("Genesis 1")).toBe(false)
  })
})

describe("Treasure Hunt heading references", () => {
  it("reads the book from a heading that names one", () => {
    expect(parseTreasureHuntReference("Genesis 1:1")).toEqual({ bookCode: "GEN", chapter: "1" })
    expect(parseTreasureHuntReference("Revelation")).toEqual({ bookCode: "REV" })
    expect(parseTreasureHuntReference("Song of Songs 2:1")).toEqual({
      bookCode: "SNG",
      chapter: "2",
    })
  })

  it("prefers the longer of two book names that share an opening", () => {
    expect(parseTreasureHuntReference("1 John 4:7\u20138")?.bookCode).toBe("1JN")
    expect(parseTreasureHuntReference("John 3:16")?.bookCode).toBe("JHN")
    expect(parseTreasureHuntReference("2 Corinthians 5")?.bookCode).toBe("2CO")
  })

  it("does not match a book name that runs on into another word", () => {
    expect(parseTreasureHuntReference("Judea in the first century")).toBeUndefined()
    expect(parseTreasureHuntReference("Jude 1:3")?.bookCode).toBe("JUD")
  })

  it("reads a verse range as a single chapter", () => {
    // The dash between verses is not a chapter span.
    expect(parseTreasureHuntReference("Genesis 2:8\u221215")).toEqual({
      bookCode: "GEN",
      chapter: "2",
    })
    expect(parseTreasureHuntReference("1 Chronicles 16:8\u201330, 36")).toEqual({
      bookCode: "1CH",
      chapter: "16",
    })
  })

  it("reads a chapter span from a heading that gives bare chapter numbers", () => {
    expect(parseTreasureHuntReference("1 Corinthians 13 \u2013 14")).toEqual({
      bookCode: "1CO",
      chapter: "13",
      lastChapter: "14",
    })
    expect(parseTreasureHuntReference("1 Chronicles 1 \u2013 9")).toEqual({
      bookCode: "1CH",
      chapter: "1",
      lastChapter: "9",
    })
  })

  it("reads every chapter a heading crosses into, in order", () => {
    expect(parseTreasureHuntReference("Genesis 7:12, 17, 24, 8:3\u221214")).toEqual({
      bookCode: "GEN",
      chapter: "7",
      lastChapter: "8",
    })
    expect(parseTreasureHuntReference("1 Samuel 1:9\u201312, 2:1")).toEqual({
      bookCode: "1SA",
      chapter: "1",
      lastChapter: "2",
    })
  })

  it("ignores a heading that names a place or a topic rather than a passage", () => {
    // The four such headings in the shipped volumes; they leave the previous
    // block's reference in effect rather than mislabelling the notes under them.
    for (const heading of ["Galatia", "Corinthians", "Timothy", "1 and 2 Thessalonians"]) {
      expect(parseTreasureHuntReference(heading)).toBeUndefined()
    }
  })

  it("labels a note by the chapter span its heading gave", () => {
    expect(treasureHuntChapterLabel({ bookCode: "GEN", chapter: "1" })).toBe("1")
    expect(treasureHuntChapterLabel({ bookCode: "GEN", chapter: "1", lastChapter: "3" })).toBe("1-3")
    expect(treasureHuntChapterLabel({ bookCode: "GEN" })).toBe("Intro")
    expect(treasureHuntChapterLabel(undefined)).toBe("Intro")
  })
})
