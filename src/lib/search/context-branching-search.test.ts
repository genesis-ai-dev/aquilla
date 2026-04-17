import { describe, it, expect, beforeEach } from "vitest"
import { ContextBranchingSearchIndex } from "./context-branching-search"

describe("ContextBranchingSearchIndex", () => {
  let index: ContextBranchingSearchIndex
  beforeEach(() => { index = new ContextBranchingSearchIndex() })

  it("returns empty for empty index", () => {
    expect(index.search("hello world")).toHaveLength(0)
  })

  it("returns empty for empty query", () => {
    index.addPair("c1", "hello", "bonjour", "f1")
    expect(index.search("")).toHaveLength(0)
    expect(index.search("   ")).toHaveLength(0)
  })

  it("finds a matching pair", () => {
    index.addPair("c1", "In the beginning God created", "Au commencement Dieu crea", "f1")
    const results = index.search("In the beginning")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
    expect(results[0].score).toBeGreaterThan(0)
    expect(results[0].matchedTokens).toContain("beginning")
  })

  it("skips pairs with no translation (buildFromProject)", () => {
    index.buildFromProject([{
      fileId: "f1",
      cells: [
        { id: "c1", original: "hello", translated: "bonjour", context: "", group: "", type: "text" },
        { id: "c2", original: "world", translated: "", context: "", group: "", type: "text" },
      ],
    }])
    expect(index.search("hello")).toHaveLength(1)
    expect(index.search("world")).toHaveLength(0)
  })

  it("branches to cover distinct query spans", () => {
    // A long query that naturally covers multiple pairs — branching should
    // surface both c1 and c2 rather than two near-duplicates of c1.
    index.addPair("c1", "In the beginning God created", "Au commencement Dieu crea", "f1")
    index.addPair("c2", "the heavens and the earth", "les cieux et la terre", "f1")
    index.addPair("c3", "and the earth was without form", "et la terre etait informe", "f1")
    const results = index.search("In the beginning God created the heavens and the earth", 3)
    const ids = results.map((r) => r.cellId)
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(ids).toContain("c1")
    expect(ids).toContain("c2")
  })

  it("does not return the same cellId twice", () => {
    index.addPair("c1", "hello world", "bonjour monde", "f1")
    index.addPair("c2", "goodbye world", "au revoir monde", "f1")
    const results = index.search("hello world goodbye", 5)
    const ids = results.map((r) => r.cellId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("removePair drops the pair from results", () => {
    index.addPair("c1", "hello world", "bonjour monde", "f1")
    expect(index.search("hello")).toHaveLength(1)
    index.removePair("c1")
    expect(index.search("hello")).toHaveLength(0)
  })

  it("coverage boost rewards the doc covering more query tokens", () => {
    // Both docs contain "river" but c2 also covers "boat" — with coverage boost
    // c2 should win even if raw BM25 score is close.
    index.addPair("c1", "the river flows past many stones along the valley", "", "f1")
    index.addPair("c2", "a boat floats on the river", "non-empty target", "f1")
    // give c1 a non-empty target so it's eligible
    index.addPair("c1", "the river flows past many stones along the valley", "non-empty target", "f1")
    const results = index.search("boat river", 1)
    expect(results[0].cellId).toBe("c2")
  })

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      index.addPair(`c${i}`, `unique${i} shared token`, `target${i}`, "f1")
    }
    const results = index.search("unique0 unique1 unique2 unique3 unique4 shared token", 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })
})
