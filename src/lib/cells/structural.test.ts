// AQU-1083. One definition of "is this cell structure", because there used to
// be two — EditorTable inlined the set for numbering and again for the cast
// gutter, with slightly different rules — and now a policy depends on it.
//
// The rule that is easy to get backwards has its own test: an untyped cell is
// CONTENT. Every media and cue import writes no type at all, so a predicate
// that read "unknown" as structural would drop a whole audio project out of
// its own denominator.

import { describe, it, expect } from "vitest"
import { applyStructuralPolicy, countsTowardProgress, isStructuralCell, STRUCTURAL_CELL_TYPES } from "./structural"

describe("isStructuralCell", () => {
  it("is true for the USFM structure types", () => {
    expect(isStructuralCell("heading")).toBe(true)
    expect(isStructuralCell("paratext")).toBe(true)
  })

  it("is false for every kind of content", () => {
    for (const type of ["verse", "text", "cue", "list", "blockquote"]) {
      expect(isStructuralCell(type)).toBe(false)
    }
  })

  it("treats an untyped cell as content", () => {
    // Media and cue imports write no type. This is the case a null-blind
    // predicate gets wrong, and it costs an entire audio project.
    expect(isStructuralCell(null)).toBe(false)
    expect(isStructuralCell(undefined)).toBe(false)
    expect(isStructuralCell("")).toBe(false)
  })

  it("does not match on a near miss", () => {
    expect(isStructuralCell("headings")).toBe(false)
    expect(isStructuralCell("Heading")).toBe(false)
  })

  it("agrees with the set the server quotes into SQL", () => {
    expect([...STRUCTURAL_CELL_TYPES]).toEqual(["heading", "paratext"])
  })
})

describe("countsTowardProgress", () => {
  it("counts everything when the policy says to", () => {
    expect(countsTowardProgress("heading", true)).toBe(true)
    expect(countsTowardProgress("verse", true)).toBe(true)
  })

  it("drops only structure when the policy excludes", () => {
    expect(countsTowardProgress("heading", false)).toBe(false)
    expect(countsTowardProgress("paratext", false)).toBe(false)
    expect(countsTowardProgress("verse", false)).toBe(true)
    expect(countsTowardProgress(null, false)).toBe(true)
  })
})

describe("applyStructuralPolicy", () => {
  const cells = [
    { type: "verse", status: "unvalidated" },
    { type: "verse", status: "empty" },
    { type: "heading", status: "validated" },
    { type: "paratext", status: "unvalidated" },
    { type: null, status: "validated" },
  ]
  // What useHealth would have counted over those five cells.
  const counted = { total: 5, translated: 4, validated: 2 }

  it("returns the input untouched when the policy counts everything", () => {
    expect(applyStructuralPolicy(counted, cells, true)).toBe(counted)
  })

  it("removes structure from every number, and only structure", () => {
    // The untyped cell is content and stays; both headings leave, taking
    // their translated and validated marks with them.
    expect(applyStructuralPolicy(counted, cells, false)).toEqual({ total: 3, translated: 2, validated: 1 })
  })

  it("returns the input untouched when nothing is structural", () => {
    const verses = cells.filter((c) => !isStructuralCell(c.type))
    const p = { total: 3, translated: 2, validated: 1 }
    expect(applyStructuralPolicy(p, verses, false)).toBe(p)
  })
})
