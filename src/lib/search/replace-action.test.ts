/**
 * Tests for replace-action.ts — pure search-and-replace logic.
 *
 * AQU-177: Search-and-replace across passages.
 */

import { describe, it, expect } from "vitest"
import {
  matchSpansHtmlTag,
  findMatches,
  applySingleCellReplace,
  computeReplaceDiffs,
  type ReplaceCandidate,
} from "./replace-action"

// ── matchSpansHtmlTag ────────────────────────────────────────────────────────

describe("matchSpansHtmlTag", () => {
  it("returns false for plain text", () => {
    expect(matchSpansHtmlTag("hello")).toBe(false)
  })

  it("returns true when match contains <", () => {
    expect(matchSpansHtmlTag("foo<b>bar")).toBe(true)
  })

  it("returns true when match contains >", () => {
    expect(matchSpansHtmlTag("foo>bar")).toBe(true)
  })

  it("returns true for a full tag", () => {
    expect(matchSpansHtmlTag("<em>word</em>")).toBe(true)
  })

  it("returns false for an empty string", () => {
    expect(matchSpansHtmlTag("")).toBe(false)
  })
})

// ── findMatches ──────────────────────────────────────────────────────────────

describe("findMatches", () => {
  it("returns empty array for empty needle", () => {
    expect(findMatches("hello world", "")).toEqual([])
  })

  it("returns empty array when no match", () => {
    expect(findMatches("hello world", "xyz")).toEqual([])
  })

  it("finds a single match", () => {
    expect(findMatches("hello world", "world")).toEqual([6])
  })

  it("finds multiple non-overlapping matches", () => {
    expect(findMatches("aaa bbb aaa", "aaa")).toEqual([0, 8])
  })

  it("is case-insensitive by default", () => {
    expect(findMatches("Hello HELLO hello", "hello")).toEqual([0, 6, 12])
  })

  it("respects caseSensitive=true", () => {
    expect(findMatches("Hello HELLO hello", "hello", true)).toEqual([12])
  })

  it("escapes regex special characters in needle", () => {
    // A literal '.' should not match any character.
    expect(findMatches("a.b acb", ".")).toEqual([1])
    expect(findMatches("a.b acb", "a.b")).toEqual([0])
    // The second 'a?b' won't be found because the needle is literal.
    expect(findMatches("a?b axb", "a?b")).toEqual([0])
  })
})

// ── applySingleCellReplace ───────────────────────────────────────────────────

describe("applySingleCellReplace", () => {
  it("returns the original string when needle is not found", () => {
    const r = applySingleCellReplace("hello world", "xyz", "abc")
    expect(r).toEqual({ result: "hello world", replaced: 0, skipped: 0 })
  })

  it("replaces a single occurrence", () => {
    const r = applySingleCellReplace("hello world", "world", "earth")
    expect(r).toEqual({ result: "hello earth", replaced: 1, skipped: 0 })
  })

  it("replaces multiple occurrences", () => {
    const r = applySingleCellReplace("aaa bbb aaa", "aaa", "ccc")
    expect(r).toEqual({ result: "ccc bbb ccc", replaced: 2, skipped: 0 })
  })

  it("replaces with empty string (delete-style)", () => {
    const r = applySingleCellReplace("foo bar foo", "foo", "")
    expect(r).toEqual({ result: " bar ", replaced: 2, skipped: 0 })
  })

  it("skips matches that span HTML tag boundaries", () => {
    // The match "oo</b>b" crosses the </b> tag boundary.
    const raw = "<b>foo</b>bar"
    const r = applySingleCellReplace(raw, "oo</b>b", "XX")
    expect(r.skipped).toBe(1)
    expect(r.replaced).toBe(0)
    // The original text is preserved.
    expect(r.result).toBe(raw)
  })

  it("replaces plain-text matches while skipping HTML-spanning ones in same string", () => {
    // "hello" appears twice: once plain, once straddling a tag.
    const raw = "Say hello and <em>hel</em>lo world"
    // needle "hello" in first occurrence is plain; second "hel</em>lo" is split by the tag.
    const r = applySingleCellReplace(raw, "hello", "hi")
    expect(r.replaced).toBe(1)
    expect(r.skipped).toBe(0) // The second token "hel</em>lo" does NOT match "hello" literally.
    expect(r.result).toBe("Say hi and <em>hel</em>lo world")
  })

  it("is case-insensitive by default", () => {
    const r = applySingleCellReplace("Hello HELLO hello", "hello", "hi")
    expect(r).toEqual({ result: "hi hi hi", replaced: 3, skipped: 0 })
  })

  it("respects caseSensitive=true", () => {
    const r = applySingleCellReplace("Hello HELLO hello", "hello", "hi", true)
    expect(r).toEqual({ result: "Hello HELLO hi", replaced: 1, skipped: 0 })
  })

  it("skips a match inside an HTML attribute value where the match text contains <", () => {
    const raw = "text <a href='page'>link</a> more text"
    // Needle that directly straddles a tag opener.
    const r = applySingleCellReplace(raw, "<a href='page'>", "ZZ")
    expect(r.skipped).toBe(1)
    expect(r.replaced).toBe(0)
    expect(r.result).toBe(raw)
  })
})

// ── computeReplaceDiffs ──────────────────────────────────────────────────────

describe("computeReplaceDiffs", () => {
  const makeCandidate = (overrides: Partial<ReplaceCandidate> & { rawValue: string }): ReplaceCandidate => ({
    cellId: "cell-1",
    fileId: "file-1",
    parentId: null,
    ...overrides,
  })

  it("returns empty diffs when no candidates", () => {
    const result = computeReplaceDiffs([], "needle", "replace")
    expect(result).toEqual({ diffs: [], totalReplaced: 0, totalSkipped: 0 })
  })

  it("excludes cells where needle is not found", () => {
    const candidates = [makeCandidate({ rawValue: "hello world" })]
    const result = computeReplaceDiffs(candidates, "xyz", "abc")
    expect(result.diffs).toHaveLength(0)
    expect(result.totalReplaced).toBe(0)
    expect(result.totalSkipped).toBe(0)
  })

  it("produces a diff for a cell with a match", () => {
    const candidates = [
      makeCandidate({ cellId: "c1", fileId: "f1", rawValue: "hello world", parentId: "evt-1" }),
    ]
    const result = computeReplaceDiffs(candidates, "world", "earth")
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0]).toMatchObject({
      cellId: "c1",
      fileId: "f1",
      parentId: "evt-1",
      before: "hello world",
      after: "hello earth",
      matchCount: 1,
    })
    expect(result.totalReplaced).toBe(1)
    expect(result.totalSkipped).toBe(0)
  })

  it("handles multiple cells, some with matches and some without", () => {
    const candidates: ReplaceCandidate[] = [
      { cellId: "c1", fileId: "f1", rawValue: "foo bar", parentId: null },
      { cellId: "c2", fileId: "f1", rawValue: "baz qux", parentId: null },
      { cellId: "c3", fileId: "f1", rawValue: "foo baz", parentId: null },
    ]
    const result = computeReplaceDiffs(candidates, "foo", "ZZZ")
    expect(result.diffs).toHaveLength(2)
    expect(result.diffs.map((d) => d.cellId)).toEqual(["c1", "c3"])
    expect(result.totalReplaced).toBe(2)
    expect(result.totalSkipped).toBe(0)
  })

  it("aggregates skipped counts from HTML-spanning matches across cells", () => {
    const candidates: ReplaceCandidate[] = [
      { cellId: "c1", fileId: "f1", rawValue: "Say <b>hello</b> world", parentId: null },
      { cellId: "c2", fileId: "f1", rawValue: "No match here", parentId: null },
    ]
    // Needle "o</b> w" spans the </b> tag.
    const result = computeReplaceDiffs(candidates, "o</b> w", "XX")
    // c1: match spans HTML — skipped, not replaced; no diff produced.
    // c2: no match.
    expect(result.diffs).toHaveLength(0)
    expect(result.totalReplaced).toBe(0)
    expect(result.totalSkipped).toBe(1)
  })

  it("produces diffs for multi-cell replace with mixed skip results", () => {
    const candidates: ReplaceCandidate[] = [
      { cellId: "c1", fileId: "f1", rawValue: "hello world", parentId: "evt-a" },
      { cellId: "c2", fileId: "f1", rawValue: "hello <b>wor</b>ld", parentId: "evt-b" },
    ]
    // "world" plain in c1, but "world" is split across a tag in c2 → no literal "world" in c2.
    const result = computeReplaceDiffs(candidates, "world", "earth")
    // c1 matches, c2 does not (no literal "world" across the tag).
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].cellId).toBe("c1")
    expect(result.totalReplaced).toBe(1)
    expect(result.totalSkipped).toBe(0)
  })

  it("preserves parentId and sourceEventId in the diff output", () => {
    const candidates: ReplaceCandidate[] = [
      {
        cellId: "c1",
        fileId: "f1",
        rawValue: "foo bar",
        parentId: "parent-evt-123",
        sourceEventId: "source-evt-456",
      },
    ]
    const result = computeReplaceDiffs(candidates, "foo", "baz")
    expect(result.diffs[0].parentId).toBe("parent-evt-123")
    expect(result.diffs[0].sourceEventId).toBe("source-evt-456")
  })

  it("correctly counts replacements per cell in matchCount", () => {
    const candidates: ReplaceCandidate[] = [
      { cellId: "c1", fileId: "f1", rawValue: "foo foo foo", parentId: null },
    ]
    const result = computeReplaceDiffs(candidates, "foo", "bar")
    expect(result.diffs[0].matchCount).toBe(3)
    expect(result.totalReplaced).toBe(3)
  })
})
