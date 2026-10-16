import { describe, expect, it } from "vitest"
import {
  findPatternError,
  findTextMatches,
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
