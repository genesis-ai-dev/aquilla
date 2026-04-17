import { describe, it, expect, beforeEach } from "vitest"
import { SearchIndex } from "./search-index"

describe("SearchIndex", () => {
  let index: SearchIndex
  beforeEach(() => { index = new SearchIndex() })

  it("returns empty results for empty index", () => {
    expect(index.search("hello world")).toHaveLength(0)
  })

  it("finds a matching pair by token overlap", () => {
    index.addPair("c1", "In the beginning God created", "Au commencement Dieu crea", "f1")
    const results = index.search("In the beginning")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
    expect(results[0].score).toBeGreaterThan(0)
  })

  it("ranks better matches higher", () => {
    index.addPair("c1", "the cat sat on the mat", "le chat", "f1")
    index.addPair("c2", "In the beginning God created the heavens", "Au commencement", "f1")
    const results = index.search("In the beginning God created", 2)
    expect(results[0].cellId).toBe("c2")
  })

  it("returns matchedTokens for highlighting", () => {
    index.addPair("c1", "God created the heavens and the earth", "Dieu crea", "f1")
    const results = index.search("God created the heavens")
    expect(results[0].matchedTokens.length).toBeGreaterThan(0)
    expect(results[0].matchedTokens).toContain("god")
    expect(results[0].matchedTokens).toContain("created")
  })

  it("uses branching to find multiple diverse results", () => {
    index.addPair("c1", "In the beginning God created", "Au commencement Dieu crea", "f1")
    index.addPair("c2", "the heavens and the earth", "les cieux et la terre", "f1")
    index.addPair("c3", "and the earth was without form", "et la terre etait informe", "f1")
    const results = index.search("In the beginning God created the heavens and the earth", 3)
    expect(results.length).toBeGreaterThanOrEqual(2)
    const ids = results.map((r) => r.cellId)
    expect(ids).toContain("c1")
    expect(ids).toContain("c2")
  })

  it("removePair removes from index", () => {
    index.addPair("c1", "hello world", "bonjour monde", "f1")
    expect(index.search("hello")).toHaveLength(1)
    index.removePair("c1")
    expect(index.search("hello")).toHaveLength(0)
  })

  it("buildFromProject populates index from translated cells only", () => {
    index.buildFromProject([{
      fileId: "f1",
      cells: [
        { id: "c1", original: "hello", translated: "bonjour", originalHtml: undefined, context: "", group: "", type: "text" },
        { id: "c2", original: "world", translated: "", originalHtml: undefined, context: "", group: "", type: "text" },
      ],
    }])
    expect(index.search("hello")).toHaveLength(1)
    expect(index.search("world")).toHaveLength(0)
  })

  it("handles empty query", () => {
    index.addPair("c1", "hello", "bonjour", "f1")
    expect(index.search("")).toHaveLength(0)
  })

  it("skips pairs with empty source", () => {
    index.addPair("c1", "", "bonjour", "f1")
    expect(index.search("hello")).toHaveLength(0)
    index.buildFromProject([{
      fileId: "f1",
      cells: [
        { id: "c2", original: "   ", translated: "bonjour", context: "", group: "", type: "text" },
        { id: "c3", original: "hello", translated: "bonjour", context: "", group: "", type: "text" },
      ],
    }])
    const r = index.search("hello")
    expect(r).toHaveLength(1)
    expect(r[0].cellId).toBe("c3")
  })

  it("filters to validated pairs only when onlyValidated is set", () => {
    index.buildFromProject([{
      fileId: "f1",
      cells: [
        { id: "c1", original: "hello world", translated: "bonjour monde", context: "", group: "", type: "text", status: "validated" },
        { id: "c2", original: "hello world", translated: "salut monde", context: "", group: "", type: "text", status: "unvalidated" },
      ],
    }])
    const all = index.search("hello world", 5)
    expect(all.map((r) => r.cellId).sort()).toEqual(["c1", "c2"])
    const validated = index.search("hello world", 5, { onlyValidated: true })
    expect(validated.map((r) => r.cellId)).toEqual(["c1"])
  })
})
