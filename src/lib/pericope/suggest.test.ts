import { describe, expect, it } from "vitest"
import raw from "./bible-section-counts.txt?raw"
import { indexSections, parseSectionCounts } from "./sections"
import { suggestPericopes } from "./suggest"
import { resolvePericopeResume } from "./resume"

const FIXTURE = indexSections(parseSectionCounts([
  "Gen.1.1\tGen.1.5\tGen.1.6\t2",
  "Gen.1.1\tGen.1.31\tGen.2.1\t4",
  "Gen.1.1\tGen.2.3\tGen.2.4\t14",
  "Gen.2.4\tGen.2.25\tGen.3.1\t15",
  "Gen.3.1\tGen.3.24\tGen.4.1\t18",
].map((row) => `${row}`).join("\n")))

describe("suggestPericopes", () => {
  it("offers the boundaries at the start of the book, strongest first", () => {
    const suggestions = suggestPericopes(FIXTURE, { book: "GEN" })
    expect(suggestions.map((s) => [s.startRef, s.endRef, s.translations])).toEqual([
      ["GEN 1:1", "GEN 2:3", 14],
      ["GEN 1:1", "GEN 1:31", 4],
      ["GEN 1:1", "GEN 1:5", 2],
    ])
    expect(suggestions.every((s) => s.continuation === false)).toBe(true)
  })

  it("resumes from where the translator left off rather than the top of the book", () => {
    const suggestions = suggestPericopes(FIXTURE, { book: "GEN", from: { chapter: 2, verse: 4 } })
    expect(suggestions.map((s) => s.startRef)).toEqual(["GEN 2:4"])
    expect(suggestions[0]?.endRef).toBe("GEN 2:25")
  })

  it("clips to the resume point when it sits inside a section", () => {
    const suggestions = suggestPericopes(FIXTURE, { book: "GEN", from: { chapter: 1, verse: 6 } })
    expect(suggestions.map((s) => [s.startRef, s.endRef, s.continuation])).toEqual([
      ["GEN 1:6", "GEN 2:3", true],
      ["GEN 1:6", "GEN 1:31", true],
    ])
  })

  it("falls forward to the next boundary when the dataset covers nothing at or across the resume point", () => {
    const sparse = indexSections(parseSectionCounts("Gen.3.1\tGen.3.24\tGen.4.1\t18"))
    const suggestions = suggestPericopes(sparse, { book: "GEN", from: { chapter: 2, verse: 4 } })
    expect(suggestions.map((s) => [s.startRef, s.endRef])).toEqual([["GEN 3:1", "GEN 3:24"]])
  })

  it("honours the limit and keeps only the strongest option per end verse", () => {
    expect(suggestPericopes(FIXTURE, { book: "GEN", limit: 2 })).toHaveLength(2)
    expect(suggestPericopes(FIXTURE, { book: "GEN", limit: 0 })).toEqual([])
  })

  it("returns nothing for a book the dataset does not carry, and past the last boundary", () => {
    expect(suggestPericopes(FIXTURE, { book: "REV" })).toEqual([])
    expect(suggestPericopes(FIXTURE, { book: "GEN", from: { chapter: 9, verse: 1 } })).toEqual([])
  })

  it("accepts a lowercase book code", () => {
    expect(suggestPericopes(FIXTURE, { book: "gen" })).toHaveLength(3)
  })
})

describe("suggestPericopes over the real dataset", () => {
  const index = indexSections(parseSectionCounts(raw))

  it("opens Genesis on the boundary most surveyed Bibles agree on", () => {
    const [first] = suggestPericopes(index, { book: "GEN" })
    expect(first?.startRef).toBe("GEN 1:1")
    // Gen 1:1–2:3 is drawn by 14 of the 20 surveyed translations.
    expect(first?.endRef).toBe("GEN 2:3")
    expect(first?.translations).toBeGreaterThanOrEqual(10)
  })

  it("ranks by translation count, never by dataset order", () => {
    const suggestions = suggestPericopes(index, { book: "MRK", from: { chapter: 4, verse: 1 } })
    expect(suggestions.length).toBeGreaterThan(0)
    const counts = suggestions.map((s) => s.translations)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })
})

describe("resolvePericopeResume", () => {
  it("points at the first untranslated cell", () => {
    expect(resolvePericopeResume([
      { canonicalRef: "GEN 1:1", translated: true },
      { canonicalRef: "GEN 1:2", translated: true },
      { canonicalRef: "GEN 1:3", translated: false },
      { canonicalRef: "GEN 1:4", translated: false },
    ])).toEqual({ book: "GEN", from: { chapter: 1, verse: 3 } })
  })

  it("starts at the top when nothing has been translated yet", () => {
    expect(resolvePericopeResume([
      { canonicalRef: "GEN 1:1", translated: false },
    ])).toEqual({ book: "GEN", from: { chapter: 1, verse: 1 } })
  })

  it("has nothing to suggest for a finished book or a file with no scripture refs", () => {
    expect(resolvePericopeResume([
      { canonicalRef: "GEN 1:1", translated: true },
    ])).toBeNull()
    expect(resolvePericopeResume([
      { canonicalRef: null, translated: false },
      { translated: false },
    ])).toBeNull()
  })

  it("ignores cells addressed to another book so a stray ref cannot move the resume point", () => {
    expect(resolvePericopeResume([
      { canonicalRef: "GEN 1:1", translated: true },
      { canonicalRef: "MAT 1:1", translated: false },
      { canonicalRef: "GEN 1:2", translated: false },
    ])).toEqual({ book: "GEN", from: { chapter: 1, verse: 2 } })
  })
})
