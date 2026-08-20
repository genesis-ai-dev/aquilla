import { describe, expect, it } from "vitest"
import {
  classifyReach4LifeUnit,
  contentTypeForSection,
  decodeStyleName,
  isReach4LifeBookTitleStyle,
  isRunningHeadGlyph,
  isStructuralOnlyContent,
  normalizeGroup,
  parseReach4LifeBookCode,
  sectionForStyle,
  styleParts,
} from "./note-rules"

/** The engine reports the style exactly as InDesign stores it. */
function applied(styleName: string): string {
  return `ParagraphStyle/${styleName.replace(/:/g, "%3a")}`
}

describe("decodeStyleName", () => {
  it("strips the engine's prefix and decodes the group separator", () => {
    expect(decodeStyleName(applied("Paragraphs:Regular paragraphs:p")))
      .toBe("Paragraphs:Regular paragraphs:p")
    expect(decodeStyleName(applied("R4Lv4 Paragraph Styles:10_HOT Hot Topics:ms3")))
      .toBe("R4Lv4 Paragraph Styles:10_HOT Hot Topics:ms3")
  })

  it("leaves a name that carries no escapes alone", () => {
    expect(decodeStyleName("$ID/[No paragraph style]")).toBe("$ID/[No paragraph style]")
    expect(decodeStyleName("ParagraphStyle/$ID/[No paragraph style]"))
      .toBe("$ID/[No paragraph style]")
  })

  it("keeps a malformed escape rather than throwing", () => {
    expect(decodeStyleName("ParagraphStyle/100%bonus")).toBe("100%bonus")
  })
})

describe("styleParts", () => {
  it("separates the group path from the marker", () => {
    expect(styleParts(applied("R4Lv4 Paragraph Styles:7_Psalms:Poetry:q1"))).toEqual({
      groups: ["R4Lv4 Paragraph Styles", "7_Psalms", "Poetry"],
      marker: "q1",
    })
  })

  it("reports an ungrouped style as a marker with no groups", () => {
    expect(styleParts(applied("NoGroup"))).toEqual({ groups: [], marker: "NoGroup" })
  })
})

describe("normalizeGroup", () => {
  it("makes the two templates' names for one group compare equal", () => {
    expect(normalizeGroup("Metatext_BBI Bible Book Intros")).toBe("bbi bible book intros")
    expect(normalizeGroup("6_BBI Bible Book Intros")).toBe("bbi bible book intros")
    expect(normalizeGroup("Page Elements")).toBe("page elements")
    expect(normalizeGroup("0_Page elements")).toBe("page elements")
  })
})

describe("classifyReach4LifeUnit", () => {
  it("reads the scripture volume's typographic groups as Bible text", () => {
    for (const style of [
      "Paragraphs:Regular paragraphs:p",
      "Paragraphs:Regular paragraphs:p-chpt1",
      "Paragraphs:List items:li1",
      "Paragraphs:Special list:pi1-b",
      "Poetry:q1",
      "Poetry:pc-b",
      "Embedded:Embedded prose:pm",
      "Headings:s1",
      "Titles:mt1",
    ]) {
      expect(classifyReach4LifeUnit(applied(style)), style).toBe("scripture")
    }
  })

  it("reads the material set around that text as content", () => {
    for (const style of [
      "Metatext_BBI Bible Book Intros:im",
      "Metatext_BBI Bible Book Intros:imt1",
      "Metatext_BBI Bible Book Intros:cl",
      "Intros:ili",
      "Intros:imte1",
      "Copyright:pc",
      "Additional:TOC Entry",
    ]) {
      expect(classifyReach4LifeUnit(applied(style)), style).toBe("content")
    }
  })

  it("reads every workbook lesson group as content", () => {
    for (const style of [
      "R4Lv4 Paragraph Styles:2_Title page:mt1",
      "R4Lv4 Paragraph Styles:3_TOC How to Use:tc1",
      "R4Lv4 Paragraph Styles:4_WAI:m",
      "R4Lv4 Paragraph Styles:5_Story:ms2",
      "R4Lv4 Paragraph Styles:8_T4J Journeys:li1",
      "R4Lv4 Paragraph Styles:9_SIE:ms3",
      "R4Lv4 Paragraph Styles:10_HOT Hot Topics:p",
      "R4Lv4 Paragraph Styles:11_DEEP Thats Deep:m-b",
      "R4Lv4 Paragraph Styles:12_R4L Group:li2",
      "R4Lv4 Paragraph Styles:13_Copyright:m",
    ]) {
      expect(classifyReach4LifeUnit(applied(style)), style).toBe("content")
    }
  })

  it("keeps a verse quoted inside a lesson, because it is part of that lesson", () => {
    // Same `q1` marker as the scripture volume's poetry, under a lesson group.
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:4_WAI:q1"))).toBe("content")
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:5_Story:q2"))).toBe("content")
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:8_T4J Journeys:q")))
      .toBe("content")
    // Its reference caption is copy the translator writes too.
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:4_WAI:qr"))).toBe("content")
  })

  it("skips the Psalms reading, which is continuous scripture", () => {
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:7_Psalms:Poetry:q1")))
      .toBe("scripture")
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:7_Psalms:Poetry:q1-b")))
      .toBe("scripture")
    // The psalm's own superscription and its acrostic letters travel with it.
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:d-h")))
      .toBe("scripture")
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:qa")))
      .toBe("scripture")
  })

  it("keeps the Reach4Life heading that introduces a psalm reading", () => {
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:cl")))
      .toBe("content")
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:7_Psalms:Psalm heading:s1")))
      .toBe("content")
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:7_Psalms:ms1"))).toBe("content")
  })

  it("skips page furniture from either template", () => {
    for (const style of [
      "Page Elements:h",
      "Page Elements:toc1",
      "Page Elements:bbi tag",
      "R4Lv4 Paragraph Styles:0_Page elements:rh1",
      "R4Lv4 Paragraph Styles:0_Page elements:rem",
      "R4Lv4 Paragraph Styles:#NB PINK to check",
    ]) {
      expect(classifyReach4LifeUnit(applied(style)), style).toBe("furniture")
    }
    expect(classifyReach4LifeUnit("$ID/[No paragraph style]")).toBe("furniture")
  })

  it("treats an unrecognised style as content, so new copy is never dropped", () => {
    expect(classifyReach4LifeUnit(applied("R4Lv4 Paragraph Styles:14_Brand New:m")))
      .toBe("content")
  })
})

describe("sectionForStyle", () => {
  it("names a workbook feature by the group that owns it, not the template root", () => {
    expect(sectionForStyle(applied("R4Lv4 Paragraph Styles:4_WAI:m")))
      .toEqual({ id: "wai", label: "Who am I?" })
    expect(sectionForStyle(applied("R4Lv4 Paragraph Styles:8_T4J Journeys:li1")))
      .toEqual({ id: "t4j journeys", label: "The 4 journeys" })
    expect(sectionForStyle(applied("R4Lv4 Paragraph Styles:11_DEEP Thats Deep:ms1")))
      .toEqual({ id: "deep thats deep", label: "That's deep" })
  })

  it("gives both templates' book introductions one section", () => {
    expect(sectionForStyle(applied("Metatext_BBI Bible Book Intros:im")))
      .toEqual(sectionForStyle(applied("R4Lv4 Paragraph Styles:6_BBI Bible Book Intros:m-b")))
  })

  it("groups every paragraph of one feature together, whatever its marker", () => {
    const heading = sectionForStyle(applied("R4Lv4 Paragraph Styles:5_Story:ms2"))
    const body = sectionForStyle(applied("R4Lv4 Paragraph Styles:5_Story:m"))
    const quote = sectionForStyle(applied("R4Lv4 Paragraph Styles:5_Story:q1"))
    expect(heading).toEqual(body)
    expect(body).toEqual(quote)
  })

  it("falls back to the group's own name when the edition adds a feature", () => {
    expect(sectionForStyle(applied("R4Lv4 Paragraph Styles:14_Brand New:m")))
      .toEqual({ id: "brand new", label: "Brand New" })
  })
})

describe("contentTypeForSection", () => {
  it("separates book introductions, workbook teaching, and apparatus", () => {
    expect(contentTypeForSection("bbi bible book intros")).toBe("book-intro")
    expect(contentTypeForSection("wai")).toBe("lesson")
    expect(contentTypeForSection("hot hot topics")).toBe("lesson")
    expect(contentTypeForSection("copyright")).toBe("front-matter")
    expect(contentTypeForSection("additional")).toBe("front-matter")
  })
})

describe("isReach4LifeBookTitleStyle", () => {
  it("recognises the title that opens a book introduction in either template", () => {
    expect(isReach4LifeBookTitleStyle(applied("Metatext_BBI Bible Book Intros:imt1"))).toBe(true)
    expect(isReach4LifeBookTitleStyle(applied("R4Lv4 Paragraph Styles:6_BBI Bible Book Intros:imt1")))
      .toBe(true)
  })

  it("does not mistake the scripture page's own book title for it", () => {
    expect(isReach4LifeBookTitleStyle(applied("Titles:mt1"))).toBe(false)
    expect(isReach4LifeBookTitleStyle(applied("Metatext_BBI Bible Book Intros:is1"))).toBe(false)
  })
})

describe("parseReach4LifeBookCode", () => {
  it("reads the book a title names", () => {
    expect(parseReach4LifeBookCode("Matthew")).toBe("MAT")
    expect(parseReach4LifeBookCode("1 Corinthians")).toBe("1CO")
    expect(parseReach4LifeBookCode("Revelation")).toBe("REV")
  })

  it("prefers the longer of two names that share an opening", () => {
    expect(parseReach4LifeBookCode("1 John")).toBe("1JN")
    expect(parseReach4LifeBookCode("John")).toBe("JHN")
  })

  it("does not match a word that merely starts with a book name", () => {
    expect(parseReach4LifeBookCode("Judea")).toBeUndefined()
    expect(parseReach4LifeBookCode("Hot topics")).toBeUndefined()
  })
})

describe("visible-text rules", () => {
  it("treats an ACE-marker-only frame as structural", () => {
    expect(isStructuralOnlyContent(["<?ACE 18?>"])).toBe(true)
    expect(isStructuralOnlyContent(["  ", "\n"])).toBe(true)
    expect(isStructuralOnlyContent(["Who am I?"])).toBe(false)
  })

  it("recognises the half of a running head that is only the separator", () => {
    expect(isRunningHeadGlyph(" | ")).toBe(true)
    expect(isRunningHeadGlyph("Who am I? | ")).toBe(false)
    expect(isRunningHeadGlyph("   ")).toBe(false)
  })
})
