import { describe, it, expect } from "vitest"
import { levenshteinDistance, normalizedEditDistance } from "./edit-distance"

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0)
    expect(levenshteinDistance("", "")).toBe(0)
  })

  it("returns length of longer string when one is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3)
    expect(levenshteinDistance("abc", "")).toBe(3)
  })

  it("counts substitutions", () => {
    // "kitten" → "sitten" → "sittin" → "sitting" = 3 ops
    expect(levenshteinDistance("kitten", "sitting")).toBe(3)
  })

  it("counts insertions and deletions", () => {
    expect(levenshteinDistance("abc", "ab")).toBe(1)
    expect(levenshteinDistance("ab", "abc")).toBe(1)
    expect(levenshteinDistance("a", "b")).toBe(1)
  })

  it("is symmetric", () => {
    expect(levenshteinDistance("hello world", "world hello")).toBe(
      levenshteinDistance("world hello", "hello world"),
    )
  })

  it("handles unicode strings", () => {
    // Identical unicode
    expect(levenshteinDistance("こんにちは", "こんにちは")).toBe(0)
    // One char substitution
    expect(levenshteinDistance("こんにちは", "こんにちわ")).toBe(1)
  })
})

describe("normalizedEditDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(normalizedEditDistance("hello", "hello")).toBe(0)
    expect(normalizedEditDistance("", "")).toBe(0)
  })

  it("returns 1 when one string is empty and the other is not", () => {
    expect(normalizedEditDistance("", "abc")).toBe(1)
    expect(normalizedEditDistance("abc", "")).toBe(1)
  })

  it("returns value in [0, 1]", () => {
    const ned = normalizedEditDistance("The quick brown fox", "A slow red fox")
    expect(ned).toBeGreaterThanOrEqual(0)
    expect(ned).toBeLessThanOrEqual(1)
  })

  it("is lower for more similar strings", () => {
    const close = normalizedEditDistance("hello world", "hello worlds")
    const far = normalizedEditDistance("hello world", "zzzzzzzzzzz")
    expect(close).toBeLessThan(far)
  })

  it("normalizes by max length, not sum", () => {
    // distance("ab", "b") = 1, max("ab","b") = 2 → 0.5
    expect(normalizedEditDistance("ab", "b")).toBeCloseTo(0.5, 5)
  })
})
