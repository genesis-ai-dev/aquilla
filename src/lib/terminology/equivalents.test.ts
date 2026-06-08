import { describe, it, expect } from "vitest"
import { predictEquivalents } from "./equivalents"
import type { BilingualPair } from "@/lib/completion/chi-square-align"

/**
 * WHY these tests exist:
 * The contract (spec Slice 3 + pre-mortem P6/P10) is that a probabilistic guess
 * must never masquerade as a settled fact. So the cross-check between χ² and
 * IBM Model 1 EM must yield HIGH confidence ONLY on agreement, AMBER on a lone
 * signal, and every prediction must carry real few-shot evidence drawn from the
 * corpus. These tests fail if any of those invariants regress.
 */

/**
 * A corpus where "god" <-> "dios" is unambiguous and dense. Enough pairs (>= 50)
 * to warm IBM Model 1 EM so the EM signal is meaningful, with "dios" appearing
 * in every "god" sentence.
 */
function buildAgreementCorpus(): BilingualPair[] {
  const pairs: BilingualPair[] = []
  for (let i = 0; i < 30; i++) {
    pairs.push({ source: `god is good number ${i}`, target: `dios es bueno numero ${i}` })
  }
  for (let i = 0; i < 30; i++) {
    pairs.push({ source: `the king rules land ${i}`, target: `el rey gobierna tierra ${i}` })
  }
  return pairs
}

describe("predictEquivalents", () => {
  it("yields HIGH confidence + source 'both' when χ² and EM agree", () => {
    const pairs = buildAgreementCorpus()
    const result = predictEquivalents(pairs, "god")
    const dios = result.find((r) => r.target === "dios")
    expect(dios).toBeDefined()
    expect(dios!.confidence).toBe("HIGH")
    expect(dios!.source).toBe("both")
    // Both signals must be populated when they agree.
    expect(dios!.chi2).toBeGreaterThan(0)
    expect(dios!.emProb).toBeGreaterThan(0)
  })

  it("examples are real corpus pairs containing the source term", () => {
    const pairs = buildAgreementCorpus()
    const result = predictEquivalents(pairs, "god")
    const dios = result.find((r) => r.target === "dios")!
    expect(dios.examples.length).toBeGreaterThan(0)
    expect(dios.examples.length).toBeLessThanOrEqual(3)
    for (const ex of dios.examples) {
      // Each example must be a genuine pair from the corpus.
      expect(pairs).toContainEqual(ex)
      // And must actually contain the source term (few-shot evidence).
      expect(ex.source.toLowerCase()).toContain("god")
    }
  })

  it("caps a χ²-only candidate (no EM corroboration) at AMBER, never HIGH", () => {
    // Tiny corpus (< 50 pairs) → EM stays in Dice cold-start, probTable per the
    // cold path may still surface some, so we craft a token only χ² sees: a rare
    // target word co-occurring once. We assert no χ²-only row is ever HIGH.
    const pairs: BilingualPair[] = [
      { source: "god is good", target: "dios es bueno" },
      { source: "god is love", target: "dios es amor" },
      { source: "god reigns alone", target: "dios reina solo" },
    ]
    const result = predictEquivalents(pairs, "god")
    for (const r of result) {
      if (r.source === "chi2") {
        expect(r.confidence).toBe("AMBER")
      }
      // No prediction is ever silently elevated above the agreement it earns.
      if (r.confidence === "HIGH") {
        expect(r.source).toBe("both")
      }
    }
  })

  it("returns empty for an absent source term", () => {
    const pairs = buildAgreementCorpus()
    expect(predictEquivalents(pairs, "nonexistentword")).toEqual([])
  })

  it("ranks HIGH-confidence predictions ahead of AMBER/LOW", () => {
    const pairs = buildAgreementCorpus()
    const result = predictEquivalents(pairs, "god")
    const bandRank = { HIGH: 0, AMBER: 1, LOW: 2 } as const
    for (let i = 1; i < result.length; i++) {
      expect(bandRank[result[i].confidence]).toBeGreaterThanOrEqual(
        bandRank[result[i - 1].confidence],
      )
    }
  })

  it("does not mutate the input pairs", () => {
    const pairs = buildAgreementCorpus()
    const snapshot = JSON.stringify(pairs)
    predictEquivalents(pairs, "god")
    expect(JSON.stringify(pairs)).toBe(snapshot)
  })
})
