import { describe, it, expect } from "vitest"
import {
  buildCanonicalRollup,
  hasCanonicalReferences,
  parseCanonicalRef,
} from "./canonical-rollup"
import type { CellRow } from "@/lib/sync/cells-read-types"

/** Minimal CellRow builder — only the fields the rollup reads vary per call. */
function row(over: Partial<CellRow> & { cellId: string; side: "source" | "target" }): CellRow {
  return {
    value: "",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: "evt",
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 0,
    ...over,
  }
}

/** Build a source+target pair for one verse cell. */
function versePair(cellId: string, ref: string, opts: { filled?: boolean; approved?: boolean } = {}): CellRow[] {
  return [
    row({ cellId, side: "source", canonicalRef: ref, value: "source text" }),
    row({
      cellId,
      side: "target",
      canonicalRef: ref,
      value: opts.filled ? "translated text" : "",
      validated: opts.approved ?? false,
    }),
  ]
}

describe("parseCanonicalRef", () => {
  it("parses a standard book/chapter/verse reference", () => {
    expect(parseCanonicalRef("GEN 1:1")).toEqual({ book: "GEN", chapter: "1", verse: "1" })
  })

  it("parses a verse range", () => {
    expect(parseCanonicalRef("LUK 1:1-2")).toEqual({ book: "LUK", chapter: "1", verse: "1-2" })
  })

  it("does not hard-code a book list — any token works generically", () => {
    // WHY (AQU-493): detection must be shape-based, not a closed enum of
    // canonical Bible book codes, or a non-canonical file (OBS stories,
    // project-defined pseudo-books) would silently fall back to the flat
    // view even though its refs are perfectly well-formed.
    expect(parseCanonicalRef("OBS 1:3")).toEqual({ book: "OBS", chapter: "1", verse: "3" })
    expect(parseCanonicalRef("ZZZ99 12:4")).toEqual({ book: "ZZZ99", chapter: "12", verse: "4" })
  })

  it("returns null for non-reference strings", () => {
    expect(parseCanonicalRef(null)).toBeNull()
    expect(parseCanonicalRef(undefined)).toBeNull()
    expect(parseCanonicalRef("")).toBeNull()
    expect(parseCanonicalRef("some free text")).toBeNull()
    expect(parseCanonicalRef("segment-uuid-1234")).toBeNull()
  })
})

describe("hasCanonicalReferences", () => {
  it("is true when at least one row has a parseable ref", () => {
    expect(hasCanonicalReferences([{ canonicalRef: null }, { canonicalRef: "GEN 1:1" }])).toBe(true)
  })

  it("is false when no row has a parseable ref (generic file)", () => {
    expect(hasCanonicalReferences([{ canonicalRef: null }, { canonicalRef: "chunk-3" }])).toBe(false)
  })

  it("is false for an empty file", () => {
    expect(hasCanonicalReferences([])).toBe(false)
  })
})

describe("buildCanonicalRollup", () => {
  it("returns null for a file with no canonical references (flat view fallback)", () => {
    const rows: CellRow[] = [
      row({ cellId: "c1", side: "source", value: "hello" }),
      row({ cellId: "c1", side: "target", value: "bonjour" }),
    ]
    expect(buildCanonicalRollup(rows)).toBeNull()
  })

  it("returns null for an empty file (no crash, no empty tree)", () => {
    expect(buildCanonicalRollup([])).toBeNull()
  })

  it("reconciles to 100% at book, chapter, and verse levels for a fully-done book", () => {
    const rows: CellRow[] = [
      ...versePair("c1", "GEN 1:1", { filled: true, approved: true }),
      ...versePair("c2", "GEN 1:2", { filled: true, approved: true }),
      ...versePair("c3", "GEN 2:1", { filled: true, approved: true }),
    ]
    const books = buildCanonicalRollup(rows)
    expect(books).not.toBeNull()
    expect(books).toHaveLength(1)
    const gen = books![0]
    expect(gen.book).toBe("GEN")
    expect(gen.cellCount).toBe(3)
    expect(gen.filledPct).toBe(100)
    expect(gen.approvedPct).toBe(100)
    expect(gen.chapters).toHaveLength(2)
    for (const chapter of gen.chapters) {
      expect(chapter.filledPct).toBe(100)
      expect(chapter.approvedPct).toBe(100)
      for (const verse of chapter.verses) {
        expect(verse.filled).toBe(true)
        expect(verse.approved).toBe(true)
      }
    }
  })

  it("computes correct partial percentages that reconcile bottom-up", () => {
    const rows: CellRow[] = [
      ...versePair("c1", "GEN 1:1", { filled: true, approved: true }),
      ...versePair("c2", "GEN 1:2", { filled: true, approved: false }),
      ...versePair("c3", "GEN 1:3", { filled: false, approved: false }),
      ...versePair("c4", "GEN 1:4", { filled: false, approved: false }),
    ]
    const books = buildCanonicalRollup(rows)!
    const gen = books[0]
    expect(gen.cellCount).toBe(4)
    expect(gen.filledCount).toBe(2)
    expect(gen.approvedCount).toBe(1)
    expect(gen.filledPct).toBe(50)
    expect(gen.approvedPct).toBe(25)

    const ch1 = gen.chapters.find((c) => c.chapterLabel === "1")!
    expect(ch1.cellCount).toBe(4)
    expect(ch1.filledPct).toBe(50)
    expect(ch1.approvedPct).toBe(25)
    expect(ch1.verses.map((v) => v.verseLabel)).toEqual(["1", "2", "3", "4"])
  })

  it("groups multiple books and sorts chapters/verses numerically (not lexically)", () => {
    const rows: CellRow[] = [
      ...versePair("c1", "GEN 10:1"),
      ...versePair("c2", "GEN 2:1"),
      ...versePair("c3", "EXO 1:1"),
    ]
    const books = buildCanonicalRollup(rows)!
    expect(books.map((b) => b.book)).toEqual(["GEN", "EXO"]) // first-seen order
    const gen = books.find((b) => b.book === "GEN")!
    // Numeric sort: chapter "2" before chapter "10" (lexical would put "10" first).
    expect(gen.chapters.map((c) => c.chapterLabel)).toEqual(["2", "10"])
  })

  it("counts an untranslated cell (no target row) as unfilled/unapproved, not dropped", () => {
    const rows: CellRow[] = [
      row({ cellId: "c1", side: "source", canonicalRef: "GEN 1:1", value: "source only" }),
    ]
    const books = buildCanonicalRollup(rows)!
    expect(books[0].cellCount).toBe(1)
    expect(books[0].filledCount).toBe(0)
    expect(books[0].filledPct).toBe(0)
  })

  it("handles a non-canonical book token generically (e.g. Open Bible Stories)", () => {
    const rows: CellRow[] = [
      ...versePair("c1", "OBS 1:1", { filled: true, approved: true }),
      ...versePair("c2", "OBS 1:2", { filled: true, approved: true }),
    ]
    const books = buildCanonicalRollup(rows)!
    expect(books).toHaveLength(1)
    expect(books[0].book).toBe("OBS")
    expect(books[0].filledPct).toBe(100)
  })
})
