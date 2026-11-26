import { describe, expect, it } from "vitest"
import {
  findPatternError,
  findTextMatches,
  markedSnippet,
  markedSnippetOfAll,
  needsSubstringSearch,
  postgresCanRunRegexp,
  preserveMatchedCase,
  replacementForMatch,
} from "../../../db/shared/find-pattern"

describe("findTextMatches", () => {
  it("is a case-insensitive literal substring by default", () => {
    expect(findTextMatches("Hello HELLO hello", "hello").map((m) => m.index)).toEqual([0, 6, 12])
    expect(findTextMatches("a.b acb", "a.b").map((m) => m.text)).toEqual(["a.b"])
  })

  it("honors match case", () => {
    expect(findTextMatches("Hello HELLO hello", "hello", { matchCase: true }).map((m) => m.text)).toEqual([
      "hello",
    ])
  })

  it("honors whole word, including a match before punctuation", () => {
    const haystack = "Goddess, the God, and God's house"
    const hits = findTextMatches(haystack, "God", { wholeWord: true })
    expect(hits.map((m) => haystack.slice(m.index, m.index + m.text.length))).toEqual(["God", "God"])
    expect(haystack.slice(hits[1].index)).toMatch(/^God's/)
  })

  it("treats letters outside ASCII as word characters", () => {
    expect(findTextMatches("ὁ λόγος καὶ λόγος.", "λόγος", { wholeWord: true }).map((m) => m.text)).toEqual([
      "λόγος",
      "λόγος",
    ])
    expect(findTextMatches("λόγος", "λόγ", { wholeWord: true })).toEqual([])
  })

  it("uses the query as a regular expression only when asked", () => {
    expect(findTextMatches("color colour", "colou?r", { useRegexp: true }).map((m) => m.text)).toEqual([
      "color",
      "colour",
    ])
    expect(findTextMatches("color", "colou?r").map((m) => m.text)).toEqual([])
  })

  it("reports an invalid regular expression and matches nothing", () => {
    expect(findPatternError("(", { useRegexp: true })).toBeTruthy()
    expect(findTextMatches("abc", "(", { useRegexp: true })).toEqual([])
    expect(findPatternError("(", {})).toBeNull()
  })

  it("expands regexp groups before preserving the match's case", () => {
    const [hit] = findTextMatches("Hello", "(Hel)lo", { matchCase: true, useRegexp: true })
    expect(replacementForMatch(hit, "$1p", { useRegexp: true })).toBe("Help")
    expect(replacementForMatch(hit, "world", { preserveCase: true })).toBe("World")
    expect(replacementForMatch(hit, "world", { useRegexp: true, preserveCase: true })).toBe("World")
  })
})

describe("preserveMatchedCase", () => {
  it("follows all-caps, lowercase, and title case, and leaves mixed case alone", () => {
    expect(preserveMatchedCase("HELLO", "world")).toBe("WORLD")
    expect(preserveMatchedCase("hello", "World")).toBe("world")
    expect(preserveMatchedCase("Hello", "world")).toBe("World")
    expect(preserveMatchedCase("HeLLo", "world")).toBe("world")
    expect(preserveMatchedCase("123", "world")).toBe("world")
  })
})

describe("postgresCanRunRegexp", () => {
  it("keeps JavaScript-only constructs out of Postgres ARE", () => {
    expect(postgresCanRunRegexp("colou?r")).toBe(true)
    expect(postgresCanRunRegexp("\\bGod\\b")).toBe(false)
    expect(postgresCanRunRegexp("(?=God)")).toBe(false)
    expect(postgresCanRunRegexp("\\p{L}+")).toBe(false)
  })
})

describe("needsSubstringSearch", () => {
  it.each([
    ["Chinese", "器皿"],
    ["Japanese kana", "うつわ"],
    ["Japanese katakana", "イスラエル"],
    ["Thai", "ภาชนะ"],
    ["Lao", "ພາຊະນະ"],
    ["Khmer", "ប្រដាប់"],
    ["Burmese", "တန်ဆာ"],
    ["Tibetan", "དཀོན་མཆོག"],
    ["Korean", "하나님"],
    ["Korean jamo", "ㅎㅏㄴ"],
  ])("is true for %s", (_name, text) => {
    expect(needsSubstringSearch(text)).toBe(true)
  })

  it.each([
    ["Latin", "vessels"],
    ["accented Latin", "créé"],
    ["Vietnamese", "Đức Chúa Trời"],
    ["Cyrillic", "сосуды"],
    ["Greek", "σκεύη"],
    ["Hebrew with points", "כְּלֵי"],
    ["Arabic", "آنية"],
    ["Devanagari", "पात्र"],
    ["Tamil", "பாத்திரம்"],
    ["Ethiopic", "ዕቃ"],
    ["Georgian", "ჭურჭელი"],
    ["Armenian", "անոթ"],
    ["digits and punctuation", "12:13 —"],
    ["CJK punctuation alone", "、。「」"],
    ["empty", ""],
  ])("is false for %s", (_name, text) => {
    expect(needsSubstringSearch(text)).toBe(false)
  })

  it("is true when one such character sits in other text", () => {
    expect(needsSubstringSearch("David 器皿")).toBe(true)
  })
})

describe("markedSnippetOfAll", () => {
  const hitsOf = (value: string, ...terms: string[]) => terms.flatMap((term) => findTextMatches(value, term))

  it("marks every hit in the window, whatever order the hits arrive in", () => {
    const value = "태초에 하나님이 천지를 창조하시니라"
    expect(markedSnippetOfAll(value, hitsOf(value, "천지", "하나님"))).toBe(
      "태초에 <mark>하나님</mark>이 <mark>천지</mark>를 창조하시니라",
    )
  })

  it("windows around the first hit and leaves hits past the window unmarked", () => {
    const value = "a".repeat(60) + "器皿" + "b".repeat(60) + "器皿"
    expect(markedSnippetOfAll(value, hitsOf(value, "器皿"))).toBe(
      "…" + "a".repeat(40) + "<mark>器皿</mark>" + "b".repeat(40) + "…",
    )
  })

  it("marks the longer of two overlapping hits once", () => {
    const value = "金銀器皿"
    expect(markedSnippetOfAll(value, hitsOf(value, "器", "器皿"))).toBe("金銀<mark>器皿</mark>")
  })

  it("agrees with markedSnippet for one hit", () => {
    const value = "並所用的一切銅器皿，"
    const [hit] = findTextMatches(value, "器皿")
    expect(markedSnippetOfAll(value, [hit])).toBe(markedSnippet(value, hit))
  })

  it("falls back to the start of the text when nothing was found to mark", () => {
    expect(markedSnippetOfAll("short", [])).toBe("short")
    expect(markedSnippetOfAll("x".repeat(100), [])).toBe("x".repeat(80) + "…")
  })
})
