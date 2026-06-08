import { describe, it, expect } from "vitest"
import { chiSquareEquivalents, type BilingualPair } from "./chi-square-align"

/**
 * WHY these tests exist:
 * χ² is the deterministic cross-check that must surface a target token which
 * co-occurs *tightly* with a source token ahead of tokens that merely appear
 * often. If that ranking ever inverts, the equivalents panel would promote
 * frequency noise over real associations — defeating the whole purpose of the
 * independence statistic.
 */

describe("chiSquareEquivalents", () => {
  it("ranks a tightly co-occurring target token highest", () => {
    // "god" always appears with "dios"; "lord" appears with a mix.
    const pairs: BilingualPair[] = [
      { source: "god is good", target: "dios es bueno" },
      { source: "god is love", target: "dios es amor" },
      { source: "god reigns", target: "dios reina" },
      { source: "the lord reigns", target: "el senor reina" },
      { source: "love is good", target: "amor es bueno" },
      { source: "the king reigns", target: "el rey reina" },
    ]

    const result = chiSquareEquivalents(pairs, "god")
    expect(result.length).toBeGreaterThan(0)
    // The tightest associate of "god" must be "dios".
    expect(result[0].target).toBe("dios")
    expect(result[0].cooccurrence).toBe(3)
    // χ² of the top candidate must beat any other candidate.
    for (const other of result.slice(1)) {
      expect(result[0].chi2).toBeGreaterThanOrEqual(other.chi2)
    }
  })

  it("scores a perfectly-aligned pair higher than a partially-aligned one", () => {
    // "fish" <-> "pez" perfect; "fish" <-> "agua" only sometimes.
    const pairs: BilingualPair[] = [
      { source: "the fish swims", target: "el pez nada en agua" },
      { source: "the fish jumps", target: "el pez salta" },
      { source: "the fish eats", target: "el pez come" },
      { source: "the bird flies", target: "el ave vuela en agua" },
    ]
    const result = chiSquareEquivalents(pairs, "fish")
    const pez = result.find((r) => r.target === "pez")
    const agua = result.find((r) => r.target === "agua")
    expect(pez).toBeDefined()
    expect(pez!.chi2).toBeGreaterThan(agua?.chi2 ?? 0)
  })

  it("drops negatively-associated target tokens (they are not equivalents)", () => {
    // "war" and "paz" (peace) are anti-correlated — never co-occur.
    const pairs: BilingualPair[] = [
      { source: "war comes", target: "guerra viene" },
      { source: "war ends", target: "guerra termina" },
      { source: "peace comes", target: "paz viene" },
      { source: "peace reigns", target: "paz reina" },
    ]
    const result = chiSquareEquivalents(pairs, "war")
    // "paz" never co-occurs with "war" → must not surface.
    expect(result.find((r) => r.target === "paz")).toBeUndefined()
    // "guerra" co-occurs perfectly → must surface as the top equivalent.
    expect(result[0].target).toBe("guerra")
  })

  it("returns empty when the source term never appears", () => {
    const pairs: BilingualPair[] = [{ source: "god is good", target: "dios es bueno" }]
    expect(chiSquareEquivalents(pairs, "absent")).toEqual([])
  })

  it("is case-insensitive on the source term", () => {
    const pairs: BilingualPair[] = [
      { source: "God reigns", target: "dios reina" },
      { source: "God is", target: "dios es" },
      { source: "the king reigns", target: "el rey reina" },
    ]
    const result = chiSquareEquivalents(pairs, "GOD")
    expect(result[0].target).toBe("dios")
  })

  it("honors maxResults", () => {
    const pairs: BilingualPair[] = [
      { source: "a a a", target: "x y z w v" },
      { source: "a a a", target: "x y z w v" },
    ]
    expect(chiSquareEquivalents(pairs, "a", { maxResults: 2 }).length).toBeLessThanOrEqual(2)
  })

  it("is deterministic across runs (stable tie-break ordering)", () => {
    const pairs: BilingualPair[] = [
      { source: "god lord", target: "dios senor" },
      { source: "god lord", target: "dios senor" },
      { source: "god king", target: "dios rey" },
    ]
    const a = chiSquareEquivalents(pairs, "god")
    const b = chiSquareEquivalents(pairs, "god")
    expect(a).toEqual(b)
  })
})
