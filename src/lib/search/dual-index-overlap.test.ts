import { describe, it, expect } from "vitest"
import { weightedJaccard, weightedTokenOverlap } from "./dual-index-overlap"
import type { ScoredPair } from "./dual-index"

function pair(cellId: string, coverageWeight: number, matchedTokens: string[] = []): ScoredPair {
  return {
    cellId, fileId: "f", source: "", target: "",
    score: coverageWeight, matchedTokens, coverageWeight,
  }
}

describe("weightedJaccard", () => {
  it("returns 0 when either set is empty", () => {
    expect(weightedJaccard([], [pair("a", 1)])).toBe(0)
    expect(weightedJaccard([pair("a", 1)], [])).toBe(0)
    expect(weightedJaccard([], [])).toBe(0)
  })

  it("returns 1 for identical sets with identical weights", () => {
    const a = [pair("a", 1), pair("b", 0.5)]
    const b = [pair("a", 1), pair("b", 0.5)]
    expect(weightedJaccard(a, b)).toBeCloseTo(1, 6)
  })

  it("returns 0 for disjoint sets", () => {
    expect(weightedJaccard([pair("a", 1)], [pair("b", 1)])).toBe(0)
  })

  it("scales by min/max for asymmetric weights", () => {
    // shared 'a' with weights 1.0 and 0.5 → min 0.5, max 1.0 → 0.5/1.0 = 0.5
    expect(weightedJaccard([pair("a", 1)], [pair("a", 0.5)])).toBeCloseTo(0.5, 6)
  })
})

describe("weightedTokenOverlap", () => {
  it("returns 0 when either side is empty", () => {
    expect(weightedTokenOverlap([], [pair("a", 1, ["x"])])).toBe(0)
    expect(weightedTokenOverlap([pair("a", 1, ["x"])], [])).toBe(0)
  })

  it("returns 1 when both sides match the same weighted tokens", () => {
    const a = [pair("a", 1, ["foo"]), pair("b", 0.5, ["bar"])]
    const b = [pair("a", 1, ["foo"]), pair("b", 0.5, ["bar"])]
    expect(weightedTokenOverlap(a, b)).toBeCloseTo(1, 6)
  })

  it("returns 0 when matched tokens don't overlap at all", () => {
    const a = [pair("a", 1, ["foo"])]
    const b = [pair("b", 1, ["bar"])]
    expect(weightedTokenOverlap(a, b)).toBe(0)
  })

  it("handles partial overlap with normalization", () => {
    const a = [pair("a", 1, ["foo", "bar"])]
    const b = [pair("b", 1, ["foo", "baz"])]
    // normalize: a → {foo:0.5, bar:0.5}; b → {foo:0.5, baz:0.5}
    // intersection {foo: min(0.5, 0.5) = 0.5}; union {foo: 0.5, bar: 0.5, baz: 0.5}
    // score = 0.5 / 1.5 = 0.3333...
    expect(weightedTokenOverlap(a, b)).toBeCloseTo(1 / 3, 6)
  })
})
