/**
 * AQU-1740 — the identity of ONE finding inside a cell's rule infraction.
 *
 * The contract these pin down: the SAME wording always hashes the same (so a
 * waiver survives reflowing, re-casing and re-composing the line), and DIFFERENT
 * wording never does (so a new problem is still flagged).
 */

import { describe, it, expect } from "vitest"
import { matchHash, normalizeMatchText } from "./match-hash"

describe("normalizeMatchText", () => {
  it("collapses whitespace so a reflowed line is the same finding", () => {
    expect(normalizeMatchText("the  the")).toBe("the the")
    expect(normalizeMatchText("the\n  the")).toBe("the the")
    expect(normalizeMatchText("  the the\t")).toBe("the the")
  })

  it("case-folds, because the checks that produce multi-span infractions do", () => {
    expect(normalizeMatchText("Amen amen")).toBe(normalizeMatchText("amen Amen"))
  })

  it("composes accents so the same word typed two ways agrees", () => {
    // "é" precomposed (U+00E9) vs. decomposed (e + U+0301).
    expect(normalizeMatchText("pré pré")).toBe(normalizeMatchText("pré pré"))
  })
})

describe("matchHash", () => {
  it("is stable for the same text", () => {
    expect(matchHash("the the")).toBe(matchHash("the the"))
  })

  it("agrees across whitespace, case and composition differences", () => {
    expect(matchHash("The\n The")).toBe(matchHash("the the"))
  })

  it("differs for different matched text — a NEW problem is a new finding", () => {
    expect(matchHash("the the")).not.toBe(matchHash("and and"))
    expect(matchHash("the the")).not.toBe(matchHash("the the the"))
  })

  it("returns '' for text with no normalized content, meaning 'no finding identity'", () => {
    expect(matchHash("")).toBe("")
    expect(matchHash("   \n\t ")).toBe("")
  })

  it("is a short, url/db-safe token rather than raw cell content", () => {
    const h = matchHash("a rather long stretch of confidential source text")
    expect(h).toMatch(/^[0-9a-z]+$/)
    expect(h.length).toBeLessThanOrEqual(12)
  })

  it("separates findings that differ only in a single character", () => {
    const hashes = new Set(
      ["dog dog", "dig dig", "dog dogs", "god god"].map((s) => matchHash(s)),
    )
    expect(hashes.size).toBe(4)
  })
})
