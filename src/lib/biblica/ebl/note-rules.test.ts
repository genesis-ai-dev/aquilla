import { describe, expect, it } from "vitest"

import {
  classifyEblUnit,
  compactHeading,
  decodeStyleName,
  eblHeadingLevel,
  headingSlug,
  isEblLessonNumberStyle,
  isEblLessonTitleStyle,
  isEblTopicNumberStyle,
  isEblTopicTitleStyle,
  isNonTextualContent,
  isStructuralOnlyContent,
  parseEblLessonNumber,
  parseEblTopicNumber,
  styleParts,
} from "./note-rules"

describe("decodeStyleName", () => {
  it("undoes the prefix and the encoded group separator InDesign writes", () => {
    expect(decodeStyleName("ParagraphStyle/07_Lessons%3ams1")).toBe("07_Lessons:ms1")
  })

  it("leaves an already plain name alone", () => {
    expect(decodeStyleName("$ID/[No paragraph style]")).toBe("$ID/[No paragraph style]")
  })
})

describe("styleParts", () => {
  it("drops the ordering prefix so a re-numbered group still compares equal", () => {
    expect(styleParts("ParagraphStyle/06_Lesson Intro%3ams3")).toEqual({
      groupId: "lesson intro",
      groupLabel: "Lesson Intro",
      marker: "ms3",
    })
    expect(styleParts("07_Lesson Intro:ms3").groupId)
      .toBe(styleParts("06_Lesson Intro:ms3").groupId)
  })

  it("trims the trailing space the template leaves on some markers", () => {
    expect(styleParts("05_Modules:ms3 ").marker).toBe("ms3")
  })

  it("reports no group for a style that names none", () => {
    expect(styleParts("$ID/[No paragraph style]")).toEqual({
      groupId: "",
      groupLabel: "",
      marker: "$ID/[No paragraph style]",
    })
  })
})

describe("eblHeadingLevel", () => {
  it("reads the level off an msN marker", () => {
    expect(eblHeadingLevel("07_Lessons:ms1")).toBe(1)
    expect(eblHeadingLevel("07_Lessons:ms2")).toBe(2)
    expect(eblHeadingLevel("07_Lessons:ms8")).toBe(8)
  })

  it("is undefined for body text", () => {
    expect(eblHeadingLevel("07_Lessons:p")).toBeUndefined()
    expect(eblHeadingLevel("02_TOC:tc1")).toBeUndefined()
    expect(eblHeadingLevel("07_Lessons:table no")).toBeUndefined()
  })

  it("does not read a decorated variant as its base level", () => {
    // These sit inside a division. Treating `ms2_shade` as level 2 would let a
    // "Materials needed" panel claim to be a lesson title.
    expect(eblHeadingLevel("06_Lesson Intro:ms2_shade ")).toBeUndefined()
    expect(eblHeadingLevel("05_Modules:ms3_shade ")).toBeUndefined()
    expect(eblHeadingLevel("07_Lessons:test summary header")).toBeUndefined()
  })
})

describe("division-opening styles", () => {
  it("recognizes a topic tag and its title only in the topic group", () => {
    expect(isEblTopicNumberStyle("06_Lesson Intro:ms3")).toBe(true)
    expect(isEblTopicTitleStyle("06_Lesson Intro:ms1")).toBe(true)
    expect(isEblTopicNumberStyle("07_Lessons:ms3")).toBe(false)
    expect(isEblTopicTitleStyle("07_Lessons:ms1")).toBe(false)
  })

  it("recognizes a lesson tag and its title only in the lesson group", () => {
    expect(isEblLessonNumberStyle("07_Lessons:ms1")).toBe(true)
    expect(isEblLessonTitleStyle("07_Lessons:ms2")).toBe(true)
    expect(isEblLessonNumberStyle("06_Lesson Intro:ms1")).toBe(false)
    expect(isEblLessonTitleStyle("06_Lesson Intro:ms2")).toBe(false)
  })
})

describe("classifyEblUnit", () => {
  it("keeps every guide style, including ones the rules do not know", () => {
    expect(classifyEblUnit("07_Lessons:p_ideas ")).toBe("content")
    expect(classifyEblUnit("07_Lessons:m_ block mid shade1")).toBe("content")
    // The cover line is set in an unnamed default and is real content.
    expect(classifyEblUnit("$ID/[No paragraph style]")).toBe("content")
  })

  it("drops auto page numbers and production notes", () => {
    expect(classifyEblUnit("*Page number")).toBe("furniture")
    expect(classifyEblUnit("*DEFAULT PARAGRAPH*")).toBe("furniture")
    expect(classifyEblUnit("07_Lessons:#NB check with editor")).toBe("furniture")
    expect(classifyEblUnit("07_Lessons:zz.proofs")).toBe("furniture")
  })
})

describe("parseEblTopicNumber", () => {
  it("reads the dotted number off a topic tag, whatever its case", () => {
    expect(parseEblTopicNumber("TOPIC 1.1")).toBe("1.1")
    expect(parseEblTopicNumber("Topic 2.6")).toBe("2.6")
  })

  it("is undefined when the tag is worded some other way", () => {
    expect(parseEblTopicNumber("Extra resource")).toBeUndefined()
    expect(parseEblTopicNumber("TOPICS")).toBeUndefined()
  })
})

describe("parseEblLessonNumber", () => {
  it("reads the number off a lesson tag", () => {
    expect(parseEblLessonNumber("Lesson 1")).toBe(1)
    expect(parseEblLessonNumber("LESSON 3")).toBe(3)
  })

  it("is undefined for a level-1 heading that numbers no lesson", () => {
    // Both really occur, set in the lesson group's own `ms1`.
    expect(parseEblLessonNumber("Words you need to know list")).toBeUndefined()
    expect(parseEblLessonNumber("Extra resource Using the mobile app")).toBeUndefined()
    // The timing badge a guide prints beside a lesson.
    expect(parseEblLessonNumber("30 min")).toBeUndefined()
  })
})

describe("compactHeading", () => {
  it("collapses whitespace and drops ACE markers", () => {
    expect(compactHeading("  How  God\tshows himself <?ACE 18?> ")).toBe("How God shows himself")
  })

  it("caps a heading so one long one cannot crowd the navigator", () => {
    const label = compactHeading("A".repeat(200))
    expect(label).toHaveLength(80)
    expect(label.endsWith("…")).toBe(true)
  })
})

describe("headingSlug", () => {
  it("makes a stable key-safe slug", () => {
    expect(headingSlug("Words you need to know list")).toBe("words-you-need-to-know-list")
    expect(headingSlug("MODULE 1 How we have the Bible")).toBe("module-1-how-we-have-the-bible")
  })

  it("never ends on a separator, however it was cut", () => {
    expect(headingSlug("How to run this programme — and why it works this way")).not.toMatch(/-$/)
    expect(headingSlug("…")).toBe("")
  })
})

describe("isStructuralOnlyContent", () => {
  it("is true for a frame holding only an ACE marker or whitespace", () => {
    expect(isStructuralOnlyContent(["<?ACE 18?>"])).toBe(true)
    expect(isStructuralOnlyContent(["  ", "\n"])).toBe(true)
  })

  it("is false once any visible text is present", () => {
    expect(isStructuralOnlyContent(["<?ACE 18?>", "30 min"])).toBe(false)
    expect(isStructuralOnlyContent(["8"])).toBe(false)
  })
})

describe("isNonTextualContent", () => {
  it("drops a table number and a ruled write-in line", () => {
    expect(isNonTextualContent(["8"])).toBe(true)
    expect(isNonTextualContent(["11"])).toBe(true)
    expect(isNonTextualContent(["-------------------"])).toBe(true)
    expect(isNonTextualContent(["________________________________________________________"])).toBe(true)
    expect(isNonTextualContent(["<?ACE 18?>"])).toBe(true)
  })

  it("keeps anything that still has a letter", () => {
    expect(isNonTextualContent(["30 min"])).toBe(false)
    expect(isNonTextualContent(["Lesson 1"])).toBe(false)
    expect(isNonTextualContent(["Write one thing you learned."])).toBe(false)
    expect(isNonTextualContent(["Introduction 3"])).toBe(false)
  })
})
