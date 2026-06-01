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
