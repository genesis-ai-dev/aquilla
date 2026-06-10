// Unit tests for the sync-worker's usfm-lossless helpers (FRO-276).
// hasIntraVerseMarkers + countLossyVerses — mirrors src/lib/parsers/usfm-lossless.test.ts.
import { describe, it, expect } from "vitest"
import {
  hasIntraVerseMarkers,
  countLossyVerses,
  parseUsfmLossless,
} from "../lib/usfm-lossless"

describe("hasIntraVerseMarkers (FRO-276)", () => {
  it("returns false for plain prose verse text", () => {
    expect(hasIntraVerseMarkers("In the beginning God created the heavens and the earth.")).toBe(false)
    expect(hasIntraVerseMarkers("The earth was without form.\n")).toBe(false)
  })

  it("detects inline footnotes (\\f...\\f*)", () => {
    expect(hasIntraVerseMarkers("...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*\n")).toBe(true)
  })

  it("detects inline cross-references (\\x...\\x*)", () => {
    expect(hasIntraVerseMarkers("some text \\x - \\xo 1:1 \\xt Gen 1:1\\x*")).toBe(true)
  })

  it("detects poetry continuation markers on their own lines", () => {
    const poeticVerse =
      "Blessed is the man\n\\q1 who walks not in the counsel of the wicked\n\\q2 nor stands in the way of sinners"
    expect(hasIntraVerseMarkers(poeticVerse)).toBe(true)
  })

  it("detects paragraph breaks inside a verse (\\p, \\m, \\b)", () => {
    expect(hasIntraVerseMarkers("first line\n\\p second paragraph\n")).toBe(true)
    expect(hasIntraVerseMarkers("line one\n\\b\n")).toBe(true)
  })

  it("detects character-level markers (\\wj, \\nd, \\add)", () => {
    expect(hasIntraVerseMarkers("He said, \\wj Come to me.\\wj*")).toBe(true)
    expect(hasIntraVerseMarkers("The \\nd Lord\\nd* your God.")).toBe(true)
    expect(hasIntraVerseMarkers("\\add (added text)\\add*")).toBe(true)
  })

  it("returns false for a verse that is only whitespace / newlines", () => {
    expect(hasIntraVerseMarkers("\n")).toBe(false)
    expect(hasIntraVerseMarkers("")).toBe(false)
  })
})

describe("countLossyVerses (FRO-276)", () => {
  const footnoteUsfm = `\\id MAT
\\c 1
\\v 4 ...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*
\\v 5 plain text`

  it("returns 0 when no overrides are provided", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    expect(countLossyVerses(doc, undefined)).toBe(0)
    expect(countLossyVerses(doc, new Map())).toBe(0)
  })

  it("returns 0 when override targets only a plain-text verse", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    const overrides = new Map([["MAT 1:5", "translated plain"]])
    expect(countLossyVerses(doc, overrides)).toBe(0)
  })

  it("returns 1 when a footnoted verse is overridden", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    const overrides = new Map([["MAT 1:4", "translated footnoted"]])
    expect(countLossyVerses(doc, overrides)).toBe(1)
  })

  it("does not count an empty override (empty cell = fall back to source)", () => {
    const doc = parseUsfmLossless(footnoteUsfm)
    const overrides = new Map([["MAT 1:4", ""]])
    expect(countLossyVerses(doc, overrides)).toBe(0)
  })

  it("counts multiple lossy verses independently", () => {
    const raw = `\\id PSA
\\c 1
\\v 1 Blessed is the man
\\q1 who walks not in the counsel of the wicked
\\v 2 But his delight
\\q1 is in the law of the LORD
\\v 3 He is like a tree`
    const doc = parseUsfmLossless(raw)
    const overrides = new Map([
      ["PSA 1:1", "Bienaventurado el varón"],
      ["PSA 1:2", "sino que en la ley de Jehová está su delicia"],
      // verse 3 plain, overriding it should not increment
      ["PSA 1:3", "Es como árbol"],
    ])
    // v1 and v2 have \q1 — lossy; v3 is plain text
    expect(countLossyVerses(doc, overrides)).toBe(2)
  })
})
