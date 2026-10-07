// AQU-463 — what the correction-learning loop is allowed to infer, and what it
// must refuse to infer. The refusals matter more than the happy path: a rule
// learned from a rewrite is applied to every later transcript in the project.

import { describe, it, expect } from "vitest"
import {
  extractCorrections,
  learnCorrections,
  applyCorrections,
  normalizeToken,
  matchCase,
  MAX_RULES,
  type CorrectionRule,
} from "./transcript-corrections"

const rule = (heard: string, corrected: string, over: Partial<CorrectionRule> = {}): CorrectionRule => ({
  heard,
  corrected,
  count: 1,
  updatedAt: 1,
  ...over,
})

describe("normalizeToken", () => {
  it("strips surrounding punctuation and case so one word is one rule", () => {
    expect(normalizeToken("Kilisusu,")).toBe("kilisusu")
    expect(normalizeToken('"kilisusu."')).toBe("kilisusu")
  })

  it("is empty for a token with no letters or digits", () => {
    expect(normalizeToken("—")).toBe("")
  })
})

describe("matchCase", () => {
  it("carries the original token's shape onto the replacement", () => {
    expect(matchCase("Killy", "kilisusu")).toBe("Kilisusu")
    expect(matchCase("KILLY", "kilisusu")).toBe("KILISUSU")
    expect(matchCase("killy", "kilisusu")).toBe("kilisusu")
  })
})

describe("extractCorrections", () => {
  it("reads a one-word fix out of an otherwise identical line", () => {
    expect(extractCorrections("he went to killy susu", "he went to kilisusu susu")).toEqual([
      { heard: "killy", corrected: "kilisusu" },
    ])
  })

  it("finds a substitution when the surrounding words shifted position", () => {
    expect(extractCorrections("and then killy spoke", "and then kilisusu spoke loudly")).toEqual([
      { heard: "killy", corrected: "kilisusu" },
    ])
  })

  it("ignores punctuation-only and case-only edits", () => {
    expect(extractCorrections("he went to killy", "He went to killy.")).toEqual([])
  })

  it("learns nothing from a pure insertion or deletion", () => {
    // Nothing transferable: no ASR token maps to a replacement token.
    expect(extractCorrections("he went to town", "he went to the town")).toEqual([])
    expect(extractCorrections("he went to the town", "he went to town")).toEqual([])
  })

  it("refuses to learn from a rewrite", () => {
    // The human typed what they heard rather than fixing a consistent error;
    // inferring rules here poisons every later transcript in the project.
    expect(extractCorrections("one two three four", "alpha bravo charlie four")).toEqual([])
  })

  it("returns nothing for empty input", () => {
    expect(extractCorrections("", "kilisusu")).toEqual([])
    expect(extractCorrections("kilisusu", "   ")).toEqual([])
  })
})

describe("learnCorrections", () => {
  it("reinforces a repeated correction instead of duplicating it", () => {
    const first = learnCorrections([], [{ heard: "killy", corrected: "kilisusu" }], 10)
    const second = learnCorrections(first, [{ heard: "killy", corrected: "kilisusu" }], 20)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ heard: "killy", corrected: "kilisusu", count: 2, updatedAt: 20 })
  })

  it("lets a newer answer replace an earlier one for the same heard word", () => {
    const first = learnCorrections([], [{ heard: "killy", corrected: "kilisusu" }], 10)
    const second = learnCorrections(first, [{ heard: "killy", corrected: "kilisusi" }], 20)
    expect(second).toHaveLength(1)
    expect(second[0].corrected).toBe("kilisusi")
  })

  it("evicts the least recently reinforced rules past the cap", () => {
    const existing = Array.from({ length: MAX_RULES }, (_, i) => rule(`word${i}`, `fixed${i}`, { updatedAt: i + 1 }))
    const next = learnCorrections(existing, [{ heard: "newest", corrected: "newest-fixed" }], 10_000)
    expect(next).toHaveLength(MAX_RULES)
    expect(next[0].heard).toBe("newest")
    expect(next.some((r) => r.heard === "word0")).toBe(false)
  })

  it("is a no-op when there is nothing to learn", () => {
    const existing = [rule("killy", "kilisusu")]
    expect(learnCorrections(existing, [])).toEqual(existing)
  })
})

describe("applyCorrections", () => {
  const rules = [rule("killy", "kilisusu")]

  it("replaces a learned word wherever it appears", () => {
    expect(applyCorrections("killy went with killy", rules)).toBe("kilisusu went with kilisusu")
  })

  it("keeps the original punctuation and capitalization around it", () => {
    expect(applyCorrections('"Killy," he said.', rules)).toBe('"Kilisusu," he said.')
  })

  it("preserves the token count so word timings stay valid", () => {
    const text = "the killy people sang"
    expect(applyCorrections(text, rules).split(/\s+/)).toHaveLength(text.split(/\s+/).length)
  })

  it("preserves the original whitespace between tokens", () => {
    expect(applyCorrections("  killy   sang\n", rules)).toBe("  kilisusu   sang\n")
  })

  it("leaves text alone when nothing has been learned", () => {
    expect(applyCorrections("killy went", [])).toBe("killy went")
  })

  it("does not match a learned word inside a longer word", () => {
    expect(applyCorrections("killybird sang", rules)).toBe("killybird sang")
  })
})

describe("the loop end to end", () => {
  it("makes the next transcript arrive already corrected", () => {
    // One human correction on clip A…
    const pairs = extractCorrections("the killy elders met", "the kilisusu elders met")
    const learned = learnCorrections([], pairs, 1)
    // …and clip B, which Whisper gets wrong the same way, comes back fixed.
    expect(applyCorrections("Killy elders spoke again.", learned)).toBe("Kilisusu elders spoke again.")
  })
})
