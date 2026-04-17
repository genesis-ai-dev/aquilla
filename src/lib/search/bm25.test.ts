import { describe, it, expect, beforeEach } from "vitest"
import { BM25Index } from "./bm25"

describe("BM25Index", () => {
  let index: BM25Index
  beforeEach(() => { index = new BM25Index() })

  it("returns empty for empty index", () => {
    expect(index.search("hello", 5)).toHaveLength(0)
  })

  it("scores exact token matches", () => {
    index.addDoc({ cellId: "c1", source: "the cat sat on the mat", target: "le chat", fileId: "f1" })
    const results = index.search("cat mat", 5)
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
    expect(results[0].score).toBeGreaterThan(0)
  })

  it("ranks docs with rarer matched tokens higher", () => {
    // "the" is common across both, "dragon" is rare — query "dragon the" should prefer c2
    index.addDoc({ cellId: "c1", source: "the cat sat on the mat", target: "", fileId: "f1" })
    index.addDoc({ cellId: "c2", source: "the dragon flew over the hill", target: "", fileId: "f1" })
    index.addDoc({ cellId: "c3", source: "the dog ran home", target: "", fileId: "f1" })
    const results = index.search("dragon the", 5)
    expect(results[0].cellId).toBe("c2")
  })

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      index.addDoc({ cellId: `c${i}`, source: "hello world", target: "", fileId: "f1" })
    }
    expect(index.search("hello", 3)).toHaveLength(3)
  })

  it("addDoc replaces existing doc with same cellId", () => {
    index.addDoc({ cellId: "c1", source: "hello", target: "", fileId: "f1" })
    index.addDoc({ cellId: "c1", source: "world", target: "", fileId: "f1" })
    expect(index.search("hello", 5)).toHaveLength(0)
    expect(index.search("world", 5)).toHaveLength(1)
    expect(index.size).toBe(1)
  })

  it("removeDoc drops the doc and its term frequencies", () => {
    index.addDoc({ cellId: "c1", source: "hello", target: "", fileId: "f1" })
    index.removeDoc("c1")
    expect(index.search("hello", 5)).toHaveLength(0)
    expect(index.size).toBe(0)
  })

  it("ignores empty queries", () => {
    index.addDoc({ cellId: "c1", source: "hello", target: "", fileId: "f1" })
    expect(index.search("", 5)).toHaveLength(0)
    expect(index.search("   ", 5)).toHaveLength(0)
  })

  it("length-normalizes: shorter docs score higher for the same tf", () => {
    index.addDoc({ cellId: "short", source: "elephant", target: "", fileId: "f1" })
    index.addDoc({ cellId: "long", source: "elephant and many other unrelated words to make this much longer", target: "", fileId: "f1" })
    const results = index.search("elephant", 5)
    expect(results[0].cellId).toBe("short")
  })
})
