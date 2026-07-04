// Acceptance tests for the analysis rows of PARITY_MATRIX.yaml.
import { describe, it, expect } from "vitest"
import { countWords, countProjectWords } from "@/lib/analysis/wordcount"
import { bucketSegments, sourceSimilarity } from "@/lib/analysis/buckets"
import { computePayable, DEFAULT_RATES } from "@/lib/analysis/payable"

describe("volume analysis", () => {
  it("[analysis.wordcount] counts words for Latin scripts, characters for CJK, one per URL/number, punctuation excluded", () => {
    expect(countWords("Hello world")).toBe(2)
    expect(countWords("Hello, world!")).toBe(2) // punctuation excluded
    expect(countWords("— … !!")).toBe(0) // punctuation-only
    expect(countWords("1,000 users paid $5.99")).toBe(4) // numbers count once
    expect(countWords("visit https://example.com/path?q=1 today")).toBe(3) // URL = 1 word
    expect(countWords("請在使用前")).toBe(5) // CJK: characters
    expect(countWords("日本語 test")).toBe(4) // 3 CJK chars + 1 Latin word
    expect(countWords("l'article n'est pas")).toBe(3) // apostrophes don't split words
    expect(countWords("")).toBe(0)
    expect(countWords("   ")).toBe(0)
  })

  it("[analysis.wordcount] aggregates per file and per project", () => {
    const result = countProjectWords([
      { fileId: "a", segments: [{ source: "one two three" }, { source: "four" }] },
      { fileId: "b", segments: [{ source: "五六七" }] },
    ])
    expect(result.files).toEqual([
      { fileId: "a", segments: 2, words: 4 },
      { fileId: "b", segments: 1, words: 3 },
    ])
    expect(result.totalSegments).toBe(3)
    expect(result.totalWords).toBe(7)
  })

  it("[analysis.repetitions] second and later identical sources land in the repetition bucket", () => {
    const buckets = bucketSegments([
      "Click Save to continue.",
      "A completely different sentence.",
      "Click Save to continue.",
      "click   save to CONTINUE.", // normalized equality: case + whitespace
      "Click Save to continue.",
    ])
    expect(buckets.map((b) => b.bucket)).toEqual([
      "new",
      "new",
      "repetition",
      "repetition",
      "repetition",
    ])
  })

  it("[analysis.internal-fuzzy] 75–99% similar segments land in the internal bucket with similarity", () => {
    const buckets = bucketSegments([
      "The quick brown fox jumps over the lazy dog today",
      "The quick brown fox jumps over the lazy cat today", // 1 token differs
      "Completely unrelated legal boilerplate about warranties.",
    ])
    expect(buckets[0].bucket).toBe("new")
    expect(buckets[1].bucket).toBe("internal_75_99")
    expect(buckets[1].similarity).toBeGreaterThanOrEqual(0.75)
    expect(buckets[1].similarity).toBeLessThan(1)
    expect(buckets[2].bucket).toBe("new")
    expect(sourceSimilarity("a b c d", "a b c d")).toBe(1)
    expect(sourceSimilarity("a b", "x y")).toBe(0)
  })

  it("[analysis.payable] applies the frozen default rate table with per-band breakdown and discount", () => {
    // Documented defaults: New 100%, Reps 30%, Internal 60%, TM100 30%, ICE 0%, MT 77%
    const result = computePayable({
      new: 1000,
      repetition: 200,
      internal_75_99: 100,
      tm_100: 50,
      ice: 30,
      mt: 100,
    })
    expect(result.totalWords).toBe(1480)
    // 1000 + 60 + 60 + 15 + 0 + 77 = 1212
    expect(result.payableWords).toBe(1212)
    expect(result.discountPct).toBeCloseTo(18.1, 1)
    const byBand = Object.fromEntries(result.bands.map((b) => [b.band, b.payable]))
    expect(byBand).toEqual({ new: 1000, repetition: 60, internal_75_99: 60, tm_100: 15, ice: 0, mt: 77 })
  })

  it("[analysis.payable] custom billing model overrides rates per project", () => {
    const custom = { ...DEFAULT_RATES, repetition: 0.1, mt: 0.5 }
    const result = computePayable({ repetition: 100, mt: 100 }, custom)
    expect(result.payableWords).toBe(60)
  })
})
