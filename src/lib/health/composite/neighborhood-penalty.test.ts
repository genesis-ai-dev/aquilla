import { describe, it, expect } from "vitest"
import { neighborhoodPenalty, type NeighborhoodInput } from "./neighborhood-penalty"
import type { ScoredPair } from "@/lib/search/dual-index"

function sp(cellId: string, cw: number, tokens: string[] = []): ScoredPair {
  return {
    cellId, fileId: "f", source: "", target: "",
    score: cw, matchedTokens: tokens, coverageWeight: cw,
  }
}

const CAP = 25
const WEIGHTS = { idJaccard: 0.5, tfidfTokenOverlap: 0.5 }

function input(partial: Partial<NeighborhoodInput> = {}): NeighborhoodInput {
  return {
    branchingSource: [],
    branchingTarget: [],
    plainSource: [],
    plainTarget: [],
    weights: WEIGHTS,
    cap: CAP,
    ...partial,
  }
}

describe("neighborhoodPenalty", () => {
  it("returns cap when both branching results are empty", () => {
    expect(neighborhoodPenalty(input())).toBe(CAP)
  })

  it("returns cap when plain source is populated but plain target is empty", () => {
    const r = neighborhoodPenalty(input({
      plainSource: [sp("a", 1, ["x"])],
      branchingSource: [sp("a", 1, ["x"])],
    }))
    // idJaccard = 0 (target empty), tfidf = 0 → blend 0 → cap
    expect(r).toBe(CAP)
  })

  it("returns 0 when both sides agree perfectly", () => {
    const pairs = [sp("a", 1, ["x"]), sp("b", 1, ["y"])]
    const r = neighborhoodPenalty(input({
      branchingSource: pairs,
      branchingTarget: pairs,
      plainSource: pairs,
      plainTarget: pairs,
    }))
    expect(r).toBeCloseTo(0, 6)
  })

  it("respects weight toggles: idJaccard weight 0 defers to tfidf only", () => {
    const pairs = [sp("a", 1, ["shared"])]
    const r = neighborhoodPenalty(input({
      branchingSource: pairs,
      branchingTarget: pairs,
      plainSource: [sp("a", 1)],
      plainTarget: [sp("b", 1)],   // disjoint on ID side
      weights: { idJaccard: 0, tfidfTokenOverlap: 1 },
    }))
    expect(r).toBeCloseTo(0, 6)
  })

  it("middle agreement yields partial penalty", () => {
    // perfect tfidf + zero idJaccard with equal weights → blend 0.5 → 0.5 * cap
    const pairs = [sp("a", 1, ["shared"])]
    const r = neighborhoodPenalty(input({
      branchingSource: pairs,
      branchingTarget: pairs,
      plainSource: [sp("a", 1)],
      plainTarget: [sp("b", 1)],
    }))
    expect(r).toBeCloseTo(CAP * 0.5, 6)
  })
})
