import { describe, it, expect } from "vitest"
import { buildGlosser, type BtSeed } from "./bt-glosser"

// ── Deterministic gloss on known pairs ───────────────────────────────────────

describe("buildGlosser — basic alignment", () => {
  it("glosses a target word that appeared in a known pair", () => {
    const pairs = [
      { source: "In the beginning", target: "Au commencement" },
      { source: "God created", target: "Dieu créa" },
    ]
    const glosser = buildGlosser(pairs)

    // "Dieu" aligned with "God" → gloss should include "god"
    const result = glosser.gloss("Dieu créa")
    expect(result.toLowerCase()).toContain("god")
  })

  it("returns literal tokens when no model data matches", () => {
    const glosser = buildGlosser([])
    const result = glosser.gloss("unknown word")
    // No pairs → returns tokenized literal
    expect(result).toBe("unknown word")
  })

  it("produces deterministic output for the same input", () => {
    const pairs = [
      { source: "the word", target: "le mot" },
      { source: "in the beginning", target: "au commencement" },
    ]
    const glosser = buildGlosser(pairs)
    const r1 = glosser.gloss("le mot")
    const r2 = glosser.gloss("le mot")
    expect(r1).toBe(r2)
  })

  it("uses bigram context when available", () => {
    const pairs = [
      { source: "the light", target: "la lumière" },
      { source: "the darkness", target: "les ténèbres" },
    ]
    const glosser = buildGlosser(pairs)
    // "lumière" should map to "light"
    const result = glosser.gloss("la lumière")
    expect(result.toLowerCase()).toContain("light")
  })
})

// ── Seed weighting ────────────────────────────────────────────────────────────

describe("buildGlosser — seed weighting", () => {
  it("positive seed boosts the alignment", () => {
    const pairs = [
      { source: "word", target: "mot" },
    ]
    const seeds: BtSeed[] = [
      { source: "scripture", target: "mot", weight: 10 },
    ]
    const glosser = buildGlosser(pairs, seeds)
    // "scripture" seed has weight 10×5=50; "word" corpus has weight ~1
    // so "scripture" should win
    const result = glosser.gloss("le mot")
    expect(result.toLowerCase()).toContain("scripture")
  })

  it("negative seed penalizes a forbidden alignment", () => {
    const pairs = [
      { source: "darkness", target: "ténèbres" },
    ]
    const seeds: BtSeed[] = [
      { source: "darkness", target: "ténèbres", weight: -100 },
    ]
    const glosser = buildGlosser(pairs, seeds)
    // Score for "darkness" → "ténèbres" should go negative → fall back to literal
    const result = glosser.gloss("ténèbres")
    // With negative score, best candidate is filtered out → literal token returned
    expect(result.toLowerCase()).toContain("ténèbres")
  })

  it("zero-weight seed is ignored", () => {
    const pairs = [{ source: "god", target: "dieu" }]
    const seeds: BtSeed[] = [{ source: "deity", target: "dieu", weight: 0 }]
    const glosser = buildGlosser(pairs, seeds)
    const result = glosser.gloss("dieu")
    // Zero seed is a no-op — corpus alignment should survive
    expect(result.toLowerCase()).toContain("god")
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("buildGlosser — edge cases", () => {
  it("returns empty string for empty input", () => {
    const glosser = buildGlosser([{ source: "a", target: "b" }])
    expect(glosser.gloss("")).toBe("")
  })

  it("returns empty string for whitespace-only input", () => {
    const glosser = buildGlosser([])
    expect(glosser.gloss("   ")).toBe("")
  })

  it("handles a single-word corpus gracefully", () => {
    const glosser = buildGlosser([{ source: "yes", target: "oui" }])
    const result = glosser.gloss("oui")
    expect(result.toLowerCase()).toBe("yes")
  })

  it("does not throw on a large input with no pairs", () => {
    const glosser = buildGlosser([])
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
    expect(() => glosser.gloss(long)).not.toThrow()
  })

  it("handles pairs with empty source or target gracefully", () => {
    const pairs = [
      { source: "", target: "something" },
      { source: "else", target: "" },
      { source: "good", target: "bon" },
    ]
    const glosser = buildGlosser(pairs)
    // Empty pairs are skipped; "bon" → "good" should still work
    expect(glosser.gloss("bon").toLowerCase()).toContain("good")
  })

  it("handles repeated pairs (multiple observations reinforce alignment)", () => {
    const pairs = Array.from({ length: 10 }, () => ({
      source: "light",
      target: "luz",
    }))
    const glosser = buildGlosser(pairs)
    const result = glosser.gloss("luz")
    expect(result.toLowerCase()).toBe("light")
  })

  it("does not throw when pairs array is empty and seeds are provided", () => {
    const seeds: BtSeed[] = [{ source: "grace", target: "gracia", weight: 5 }]
    const glosser = buildGlosser([], seeds)
    expect(() => glosser.gloss("gracia")).not.toThrow()
    const result = glosser.gloss("gracia")
    expect(result.toLowerCase()).toContain("grace")
  })
})

// ── BUG-BT-5: runaway repetition guard ───────────────────────────────────────

describe("buildGlosser — repetition guard (BUG-BT-5)", () => {
  /**
   * Regression: the statistical glosser used to produce runaway output like
   * "regent university serves regent university serves regent university serves…"
   * (~30×) because every target token mapped to the same winning source phrase
   * from the corpus.
   *
   * This test builds a corpus that biases "regent university" as the top-scored
   * alignment for almost every target token, then asserts the output is bounded
   * and does not contain long consecutive repetition.
   */
  it("does not produce runaway repetition when one phrase dominates the model", () => {
    // Build a corpus where "regent university" appears as source for MANY
    // different target words — this is exactly the scenario that caused runaway.
    const pairs = Array.from({ length: 20 }, () => ({
      source: "regent university",
      target: "regent university serves as a center of christian thought",
    }))

    const glosser = buildGlosser(pairs)
    const target = "regent university serves as a center of christian thought"
    const inputTokenCount = target.split(/\s+/).length // 9 tokens

    const result = glosser.gloss(target)
    const outputTokens = result.split(/\s+/).filter(Boolean)

    // Length cap: must be ≤ ~2× input + 10
    const maxAllowedTokens = inputTokenCount * 2 + 10
    expect(outputTokens.length).toBeLessThanOrEqual(maxAllowedTokens)

    // Repetition break: no single phrase should appear more than 2× in a row
    // (check every consecutive window of 3 tokens — if all three are the same
    // two-word phrase "regent university" that's 6 identical tokens in a row)
    const phrase = "regent university"
    const phraseWords = phrase.split(" ")
    let consecutiveMatches = 0
    let maxConsecutiveMatches = 0
    for (let i = 0; i <= outputTokens.length - phraseWords.length; i++) {
      const window = outputTokens.slice(i, i + phraseWords.length).join(" ")
      if (window === phrase) {
        consecutiveMatches++
        maxConsecutiveMatches = Math.max(maxConsecutiveMatches, consecutiveMatches)
      } else {
        consecutiveMatches = 0
      }
    }
    // At most MAX_CONSECUTIVE_REPEATS (2) consecutive occurrences of the phrase
    expect(maxConsecutiveMatches).toBeLessThanOrEqual(2)
  })

  it("output length is bounded to ~2× input token count", () => {
    // Corpus with many pairs all mapping to the same short source phrase,
    // simulating a highly skewed alignment model.
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      source: "foo bar",
      target: `word${i} token${i} extra${i}`,
    }))

    const glosser = buildGlosser(pairs)
    // A long input where most tokens map to the same "foo bar" phrase
    const target = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")
    const inputTokenCount = 40

    const result = glosser.gloss(target)
    const outputTokens = result.split(/\s+/).filter(Boolean)

    expect(outputTokens.length).toBeLessThanOrEqual(inputTokenCount * 2 + 10)
  })
})
