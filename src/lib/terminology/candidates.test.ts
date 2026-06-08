import { describe, it, expect } from "vitest"
import { extractCandidates } from "./candidates"
import type { Concept } from "./types"

function concept(sourceTerm: string): Concept {
  return {
    id: `c-${sourceTerm}`,
    sourceTerm,
    renderings: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("extractCandidates — C-value (nestedness)", () => {
  it("ranks a genuine multi-word term above the fragment that only occurs inside it", () => {
    // "holy spirit" recurs as a unit across VARIED sentences; "spirit" only
    // ever appears inside "holy spirit". C-value must downweight the nested
    // unigram "spirit" relative to the full phrase, because "spirit" adds no
    // independent termhood here. Varied surrounding words keep the longer
    // n-grams from all sharing the phrase's frequency.
    const corpus = [
      "the holy spirit came upon them",
      "they received the holy spirit gladly",
      "filled with the holy spirit again",
      "the holy spirit spoke to him",
    ]
    const out = extractCandidates(corpus, { minTermFreq: 2, maxResults: 50 })

    // The maximal frequent phrase "the holy spirit" is the real term; its
    // nested fragments ("holy spirit", "spirit", "holy") all share its
    // frequency and are driven toward zero by the nestedness adjustment — the
    // defining behaviour of C-value.
    const maximal = out.find((c) => c.term === "the holy spirit")
    const fragment = out.find((c) => c.term === "spirit")
    expect(maximal).toBeDefined()
    expect(fragment).toBeDefined()
    expect(maximal!.cValue).toBeGreaterThan(fragment!.cValue)
    expect(fragment!.cValue).toBe(0)
    // And the maximal multi-word term sits at the top of the ranked output.
    expect(out[0].term).toBe("the holy spirit")
  })

  it("does NOT downweight a word that also occurs independently of the phrase", () => {
    // "spirit" occurs both inside "holy spirit" and standalone, so it retains
    // independent termhood and is not driven to a nested-only score.
    const corpus = [
      "the holy spirit",
      "the holy spirit",
      "a willing spirit",
      "a quiet spirit",
      "her spirit was strong",
    ]
    const out = extractCandidates(corpus, { minTermFreq: 2, maxResults: 50 })
    const fragment = out.find((c) => c.term === "spirit")
    expect(fragment).toBeDefined()
    // Standalone occurrences keep its C-value positive (frequency 5, only 2
    // nested under "holy spirit").
    expect(fragment!.cValue).toBeGreaterThan(0)
  })
})

describe("extractCandidates — NC-value (context weighting)", () => {
  it("boosts a candidate that shares recurring context words with other candidates", () => {
    // Two candidate terms ("covenant", "promise") both recur next to the same
    // context word "everlasting" and "the". A candidate sharing high-signal
    // context should get an NC boost over its raw C-value.
    const corpus = [
      "the everlasting covenant stands",
      "the everlasting covenant stands",
      "the everlasting promise stands",
      "the everlasting promise stands",
    ]
    const out = extractCandidates(corpus, { minTermFreq: 2, maxResults: 50 })
    const covenant = out.find((c) => c.term === "covenant")
    expect(covenant).toBeDefined()
    // NC-value layers a non-negative context contribution on top of C-value;
    // because "everlasting"/"the"/"stands" border multiple candidates, the
    // context factor is positive and ncValue exceeds 0.8*cValue alone.
    expect(covenant!.ncValue).toBeGreaterThan(0.8 * covenant!.cValue)
  })
})

describe("extractCandidates — G² keyness", () => {
  it("flags a term frequent in the project but rare in the reference with high G²", () => {
    // "atonement" is dense in the project but vanishingly rare in the general
    // reference corpus → it should surface as a key/specialized term.
    const corpus = [
      "atonement for the people",
      "atonement for the people",
      "atonement for the people",
      "atonement for the people",
    ]
    const reference = new Map<string, number>([
      ["the", 50000],
      ["for", 20000],
      ["people", 8000],
      ["atonement", 3], // extremely rare in general language
    ])
    const out = extractCandidates(corpus, {
      minTermFreq: 2,
      reference,
      maxResults: 50,
    })
    const atonement = out.find((c) => c.term === "atonement")
    const theWord = out.find((c) => c.term === "the")
    expect(atonement).toBeDefined()
    // The specialized term is far more "key" than a common function word.
    expect(atonement!.g2).toBeGreaterThan(0)
    if (theWord) {
      expect(atonement!.g2).toBeGreaterThan(theWord!.g2)
    }
  })

  it("derives a rest-of-corpus baseline when no reference is supplied", () => {
    // No reference map: a token far above the corpus average frequency should
    // still get positive keyness via the rest-of-corpus baseline.
    const corpus = [
      "grace grace grace grace grace",
      "grace grace grace grace grace",
      "a b c d e",
      "f g h i j",
    ]
    const out = extractCandidates(corpus, { minTermFreq: 2, maxResults: 50 })
    const grace = out.find((c) => c.term === "grace")
    expect(grace).toBeDefined()
    expect(grace!.g2).toBeGreaterThan(0)
  })
})

describe("extractCandidates — managed exclusion", () => {
  it("flags terms matching an existing managed Concept's sourceTerm as managed", () => {
    const corpus = [
      "the lord is my shepherd",
      "the lord is my shepherd",
      "the lord reigns forever",
    ]
    const out = extractCandidates(corpus, {
      minTermFreq: 2,
      managed: [concept("Lord")], // case-insensitive match
      maxResults: 50,
    })
    const lord = out.find((c) => c.term === "lord")
    expect(lord).toBeDefined()
    expect(lord!.isManaged).toBe(true)

    const shepherd = out.find((c) => c.term === "shepherd")
    if (shepherd) expect(shepherd.isManaged).toBe(false)
  })
})

describe("extractCandidates — basic contracts", () => {
  it("respects minTermFreq and maxResults", () => {
    const corpus = ["alpha beta", "alpha beta", "gamma"]
    const out = extractCandidates(corpus, { minTermFreq: 2, maxResults: 1 })
    expect(out.length).toBe(1)
    // "gamma" (freq 1) is below the floor and excluded.
    expect(out.every((c) => c.frequency >= 2)).toBe(true)
  })

  it("is deterministic for the same input", () => {
    const corpus = ["the holy spirit", "the holy spirit", "holy water flows"]
    const a = extractCandidates(corpus, { minTermFreq: 2 })
    const b = extractCandidates(corpus, { minTermFreq: 2 })
    expect(a).toEqual(b)
  })

  it("returns empty for an empty corpus", () => {
    expect(extractCandidates([], {})).toEqual([])
  })

  it("caps the mined corpus to maxCorpusStrings (only the first N strings count)", () => {
    // The first 4 strings establish "alpha beta" (freq 4); the tail introduces
    // "gamma delta" (freq 4) which must NOT appear when capped to the head.
    const corpus = [
      "alpha beta",
      "alpha beta",
      "alpha beta",
      "alpha beta",
      "gamma delta",
      "gamma delta",
      "gamma delta",
      "gamma delta",
    ]
    const out = extractCandidates(corpus, {
      minTermFreq: 2,
      maxResults: 50,
      maxCorpusStrings: 4,
    })
    expect(out.some((c) => c.term === "alpha beta")).toBe(true)
    // The capped-off tail is invisible to mining.
    expect(out.some((c) => c.term.includes("gamma"))).toBe(false)
    // Without the cap, the tail's terms are mined.
    const uncapped = extractCandidates(corpus, { minTermFreq: 2, maxResults: 50 })
    expect(uncapped.some((c) => c.term === "gamma delta")).toBe(true)
  })

  it("containment optimization preserves nestedness scoring (regression)", () => {
    // Exercises the sub-n-gram containment indexing: a maximal phrase whose
    // every sub-fragment is nested must still drive the fragments' C-value to 0,
    // exactly as the prior pairwise O(n^2) check did.
    const corpus = [
      "the new covenant of grace",
      "the new covenant of grace",
      "the new covenant of grace",
    ]
    const out = extractCandidates(corpus, { minTermFreq: 2, maxResults: 50 })
    const maximal = out.find((c) => c.term === "the new covenant of grace")
    const fragment = out.find((c) => c.term === "new covenant")
    expect(maximal).toBeDefined()
    expect(fragment).toBeDefined()
    // Every proper sub-phrase shares the maximal phrase's frequency, so the
    // nestedness adjustment zeroes them out.
    expect(fragment!.cValue).toBe(0)
    expect(maximal!.cValue).toBeGreaterThan(0)
  })
})
