import { describe, it, expect } from "vitest"
import { DualIndex, type CellInput } from "./dual-index"

function cell(id: string, original: string, translated: string, fileId = "f"): CellInput {
  return { id, original, translated, fileId }
}

describe("DualIndex build / add / remove", () => {
  it("skips cells with empty original", () => {
    const ix = new DualIndex()
    ix.buildFromProject([cell("a", "", "hello")])
    expect(ix.size()).toBe(0)
  })

  it("skips cells with empty or whitespace-only translated", () => {
    const ix = new DualIndex()
    ix.buildFromProject([cell("a", "hello", ""), cell("b", "world", "   ")])
    expect(ix.size()).toBe(0)
  })

  it("indexes cells with both sides populated", () => {
    const ix = new DualIndex()
    ix.buildFromProject([
      cell("a", "in the beginning", "au commencement"),
      cell("b", "god created heaven", "dieu créa les cieux"),
    ])
    expect(ix.size()).toBe(2)
  })

  it("addPair + removePair produces same state as full rebuild", () => {
    const cells = [
      cell("a", "in the beginning", "au commencement"),
      cell("b", "god created heaven", "dieu créa les cieux"),
      cell("c", "the earth was empty", "la terre était vide"),
    ]
    const full = new DualIndex()
    full.buildFromProject(cells)

    const incr = new DualIndex()
    for (const c of cells) incr.addPair(c)
    expect(incr.size()).toBe(full.size())

    incr.removePair("b")
    expect(incr.size()).toBe(2)
    incr.addPair(cells[1])
    expect(incr.size()).toBe(3)
  })

  it("exposes per-side inverted indexes via hasToken()", () => {
    const ix = new DualIndex()
    ix.buildFromProject([cell("a", "hello world", "bonjour monde")])
    expect(ix.hasToken("source", "hello")).toBe(true)
    expect(ix.hasToken("target", "bonjour")).toBe(true)
    expect(ix.hasToken("source", "bonjour")).toBe(false)
  })

})

describe("DualIndex plain search", () => {
  it("returns [] for empty query", () => {
    const ix = new DualIndex()
    ix.buildFromProject([cell("a", "hello world", "bonjour monde")])
    expect(ix.searchPlainSource("", 5)).toEqual([])
    expect(ix.searchPlainSource("   ", 5)).toEqual([])
  })

  it("ranks candidates by IDF-weighted match and normalizes coverageWeight", () => {
    const ix = new DualIndex()
    ix.buildFromProject([
      cell("a", "in the beginning god created the heavens", "au commencement"),
      cell("b", "god created the earth", "dieu créa la terre"),
      cell("c", "the end of days", "la fin des jours"),
    ])
    const r = ix.searchPlainSource("god created", 5)
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].coverageWeight).toBe(1)  // top result normalizes to 1
    expect(r.every(p => p.coverageWeight >= 0 && p.coverageWeight <= 1)).toBe(true)
    // 'a' and 'b' both match; 'c' should not be in the top result or carry very low score
    const ids = r.map(p => p.cellId)
    expect(ids).toContain("a")
    expect(ids).toContain("b")
  })

  it("searchPlainTarget matches against target tokens", () => {
    const ix = new DualIndex()
    ix.buildFromProject([
      cell("a", "hello", "bonjour"),
      cell("b", "world", "monde"),
    ])
    const r = ix.searchPlainTarget("monde", 5)
    expect(r.map(p => p.cellId)).toEqual(["b"])
  })
})

describe("DualIndex branching search", () => {
  it("returns [] for empty query", () => {
    const ix = new DualIndex()
    ix.buildFromProject([cell("a", "hello world", "bonjour monde")])
    expect(ix.searchBranchingSource("", 5)).toEqual([])
  })

  it("emits coverageWeight as coveredTokens/queryTokens; sum over results ≤ 1", () => {
    const ix = new DualIndex()
    ix.buildFromProject([
      cell("a", "in the beginning god created heaven", "au commencement"),
      cell("b", "the earth was without form", "la terre était informe"),
      cell("c", "god created the earth", "dieu créa la terre"),
    ])
    const results = ix.searchBranchingSource("god created heaven earth", 5)
    expect(results.length).toBeGreaterThan(0)
    const sum = results.reduce((a, p) => a + p.coverageWeight, 0)
    expect(sum).toBeLessThanOrEqual(1 + 1e-9)
    expect(results.every(p => p.coverageWeight >= 0 && p.coverageWeight <= 1)).toBe(true)
  })

  it("searchBranchingTarget queries target tokens", () => {
    const ix = new DualIndex()
    ix.buildFromProject([
      cell("a", "hello", "bonjour"),
      cell("b", "world", "monde"),
      cell("c", "hello world", "bonjour monde"),
    ])
    const r = ix.searchBranchingTarget("bonjour monde", 5)
    expect(r.map(p => p.cellId)).toContain("c")
  })
})
