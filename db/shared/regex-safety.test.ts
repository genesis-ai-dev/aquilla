import { describe, expect, it } from "vitest"
import { catastrophicPatternReason } from "./regex-safety"
import { findPatternError, findTextMatches } from "./find-pattern"
import { termToRegexSource } from "../../src/lib/terminology/match"

describe("catastrophicPatternReason", () => {
  it.each([
    "(a+)+$",
    "((a+))+$",
    "(a{1,})+$",
    "(?:a|a)+$",
    "(a|ab)*c",
    "(\\w|\\s)+!",
    "(?:\\w+)+(?=!)",
    "(.*a){2,}",
    "(x+){50}",
    "(?<w>\\w+\\s?)*$",
    "(?:(?:a)+)+",
  ])("rejects %s", (pattern) => {
    expect(catastrophicPatternReason(pattern)).not.toBeNull()
  })

  it.each([
    "",
    "grace",
    "\\bLORD\\b",
    "(foo|bar)+",
    "\\w+\\s+\\w+",
    "[A-Z][a-z]+",
    "(\\d+):(\\d+)",
    "(?:ab)+",
    "(a+){0,4}",
    "(?<!\\p{L})(?:ים|י){0,4}(?![\\p{L}])",
    "colou?r",
    "\\(a+\\)+",
    "[(]a+[)]+",
    "a{2,}",
  ])("accepts %s", (pattern) => {
    expect(catastrophicPatternReason(pattern)).toBeNull()
  })

  it("passes compiled terminology patterns, affix groups included", () => {
    const source = termToRegexSource("grace*", {
      prefixes: ["be", "b"],
      suffixes: ["im", "i", "ים"],
      maxAffixes: 4,
      foldMarks: true,
    })
    expect(source).not.toBeNull()
    expect(catastrophicPatternReason(source as string)).toBeNull()
  })

  it("runs in linear time on a long pattern", () => {
    const started = Date.now()
    catastrophicPatternReason("(".repeat(5000) + "a" + ")".repeat(5000))
    catastrophicPatternReason("a|".repeat(20000))
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe("findPatternError ReDoS screen", () => {
  it("refuses a catastrophic regexp before it runs", () => {
    expect(findPatternError("(?:a|a)+$", { useRegexp: true })).toMatch(/too long/)
    expect(findTextMatches("a".repeat(40) + "!", "(?:a|a)+$", { useRegexp: true })).toEqual([])
  })

  it("leaves literal mode alone", () => {
    expect(findPatternError("(a+)+", { useRegexp: false })).toBeNull()
  })
})

describe("termToRegexSource wildcard runs", () => {
  it("collapses repeated stars to one wildcard", () => {
    expect(termToRegexSource("a**********z")).toBe(termToRegexSource("a*z"))
  })
})
