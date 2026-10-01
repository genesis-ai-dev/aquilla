import { describe, expect, it } from "vitest"
import { conceptsForSourceSurface, hasSourceTermMatch } from "./source-lookup"
import type { Concept, TermMatchingSettings } from "./types"

/**
 * AQU-1272 — the source-side lookup surfaces resolve a surface string through
 * the shared matcher. The Hebrew pair below is the reported case: the term is
 * pointed, the occurrence carries a conjunctive prefix, and every other
 * consumer of `match.ts` already recognises it.
 */
const TERM = "הָאָ֗רֶץ"
const PREFIXED = "וְהָאָ֗רֶץ"

const HEBREW_INVENTORY: TermMatchingSettings = {
  prefixes: ["ו", "ה", "ב", "ל"],
  suffixes: ["ים"],
}

function concept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "c1",
    sourceTerm: TERM,
    renderings: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("conceptsForSourceSurface", () => {
  it("resolves a prefixed occurrence of a pointed term once the project has an affix inventory", () => {
    const concepts = [concept()]
    expect(conceptsForSourceSurface(PREFIXED, concepts, HEBREW_INVENTORY)).toHaveLength(1)
  })

  it("still resolves the bare pointed term", () => {
    expect(conceptsForSourceSurface(TERM, [concept()], HEBREW_INVENTORY)).toHaveLength(1)
  })

  it("does not invent a match when the project has no inventory", () => {
    // Not a shortcoming: with no prefixes configured, a prefixed word is a
    // different word everywhere else in the stack too. The point is that this
    // surface now agrees with that instead of guessing on substrings.
    expect(conceptsForSourceSurface(PREFIXED, [concept()])).toHaveLength(0)
  })

  it("resolves a listed alternate form", () => {
    const concepts = [concept({ match: { forms: ["אֶרֶץ"] } })]
    expect(conceptsForSourceSurface("אֶרֶץ", concepts, HEBREW_INVENTORY)).toHaveLength(1)
  })

  it("rejects an excluded surface form", () => {
    const concepts = [concept({ sourceTerm: "grace", match: { excludedForms: ["graceland"] } })]
    expect(conceptsForSourceSurface("Graceland", concepts)).toHaveLength(0)
    expect(conceptsForSourceSurface("grace", concepts)).toHaveLength(1)
  })

  it("keeps the fragment affordance: part of a phrase entry still opens it", () => {
    // Selecting one word of "Holy Spirit" should reach the entry — this is a
    // lookup, not enforcement.
    const concepts = [concept({ sourceTerm: "Holy Spirit" })]
    expect(conceptsForSourceSurface("Spirit", concepts)).toHaveLength(1)
  })

  it("no longer matches on substring luck", () => {
    // "graceful" CONTAINS "grace", which is what the old bidirectional
    // includes() keyed on. The matcher is whole-word, so it does not.
    const concepts = [concept({ sourceTerm: "grace" })]
    expect(conceptsForSourceSurface("graceful", concepts)).toHaveLength(0)
  })

  it("honours a wildcard term", () => {
    const concepts = [concept({ sourceTerm: "grac*" })]
    expect(conceptsForSourceSurface("graced", concepts)).toHaveLength(1)
  })

  it("ignores punctuation at the edges of the surface", () => {
    const concepts = [concept({ sourceTerm: "grace" })]
    expect(conceptsForSourceSurface("“grace,”", concepts)).toHaveLength(1)
  })

  it("skips concepts that are not active", () => {
    expect(conceptsForSourceSurface(TERM, [concept({ status: "draft" })], HEBREW_INVENTORY)).toHaveLength(0)
  })

  it("returns nothing for a surface with no letters or digits", () => {
    expect(conceptsForSourceSurface("  — ", [concept()], HEBREW_INVENTORY)).toHaveLength(0)
  })

  it("returns every matching concept, in the order given", () => {
    const concepts = [
      concept({ id: "a", sourceTerm: "spirit" }),
      concept({ id: "b", sourceTerm: "spirit of the law" }),
    ]
    expect(conceptsForSourceSurface("spirit", concepts).map((c) => c.id)).toEqual(["a", "b"])
  })
})

describe("hasSourceTermMatch", () => {
  it("is the boolean the selection toolbar asks for", () => {
    expect(hasSourceTermMatch(PREFIXED, [concept()], HEBREW_INVENTORY)).toBe(true)
    expect(hasSourceTermMatch("unrelated", [concept()], HEBREW_INVENTORY)).toBe(false)
  })
})
