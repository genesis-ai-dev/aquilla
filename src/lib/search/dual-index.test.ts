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
