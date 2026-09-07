import { describe, expect, it, vi } from "vitest"
import { createRibbonInputCache, ribbonInputCacheFor, ribbonInputFor, stabilizeRibbonPoints, type RibbonInputCell } from "./ribbon-inputs"
import type { HealthRibbonPoint } from "./health-ribbon"

interface TestCell extends RibbonInputCell {
  original: string
}

function cell(id: string, status: string, translated: string, extra: Partial<TestCell> = {}): TestCell {
  return { id, fileId: "f1", status, translated, group: "GEN 1", original: `source ${id}`, ...extra }
}

const noExamples: Array<{ matchedTokens: string[] }> = []

describe("ribbonInputFor", () => {
  const readers = {
    sourceText: (c: TestCell) => c.original,
    health: (id: string) => (id === "auto" ? 42 : undefined),
    examples: (id: string) => (id === "empty" ? [{ matchedTokens: ["source", "empty"] }] : noExamples),
  }

  it("marks a validated cell as 100 with full weight", () => {
    expect(ribbonInputFor("v", cell("v", "validated", "done"), readers)).toEqual({
      id: "v", scope: "f1:GEN 1", stage: "validated", rawScore: 100, evidenceWeight: 1,
    })
  })

  it("reads the automatic score from the health map", () => {
    expect(ribbonInputFor("auto", cell("auto", "unvalidated", "draft"), readers)).toMatchObject({
      stage: "automatic", rawScore: 42, evidenceWeight: 1,
    })
  })

  it("scores an untranslated cell from its retrieval examples", () => {
    const input = ribbonInputFor("empty", cell("empty", "empty", ""), readers)
    expect(input.stage).toBe("untranslated")
    expect(input.rawScore).toBe(100)
    expect(input.evidenceWeight).toBeCloseTo(0.2)
  })

  it("leaves an untranslated cell unscored without examples", () => {
    const input = ribbonInputFor("bare", cell("bare", "empty", "   "), readers)
    expect(input).toEqual({ id: "bare", scope: "f1:GEN 1", stage: "untranslated", rawScore: undefined, evidenceWeight: 1 })
  })

  it("falls back to the section, then the document, for the scope", () => {
    expect(ribbonInputFor("s", cell("s", "empty", "", { group: "", section: "Intro" }), readers).scope).toBe("f1:Intro")
    expect(ribbonInputFor("d", cell("d", "empty", "", { group: "", section: undefined }), readers).scope).toBe("f1:document")
  })

  it("marks a missing cell so the ribbon does not smooth across it", () => {
    expect(ribbonInputFor("gone", null, readers)).toEqual({ id: "gone", scope: "missing", stage: "untranslated" })
  })
})

describe("createRibbonInputCache", () => {
  function harness() {
    const versions = new Map<string, number>([["a", 1], ["b", 1], ["c", 1]])
    const health = new Map<string, number>([["b", 60]])
    const examples = new Map<string, Array<{ matchedTokens: string[] }>>([["c", [{ matchedTokens: ["source", "c"] }]]])
    const cells = new Map<string, TestCell>([
      ["a", cell("a", "validated", "done")],
      ["b", cell("b", "unvalidated", "draft")],
      ["c", cell("c", "empty", "")],
    ])
    const getCell = vi.fn((id: string) => cells.get(id) ?? null)
    const readers = {
      getCellVersion: (id: string) => versions.get(id) ?? 0,
      getCell,
      sourceText: (c: TestCell) => c.original,
      health: (id: string) => health.get(id),
      examples: (id: string) => examples.get(id) ?? noExamples,
    }
    return { versions, health, examples, cells, getCell, readers, cache: createRibbonInputCache() }
  }

  it("builds every input on the first read and none on an unchanged re-read", () => {
    const h = harness()
    const first = h.cache.read(["a", "b", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(3)
    expect(first.map((input) => input.rawScore)).toEqual([100, 60, 100])

    const second = h.cache.read(["a", "b", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(0)
    expect(h.getCell).toHaveBeenCalledTimes(3)
    second.forEach((input, index) => expect(input).toBe(first[index]))
  })

  it("re-derives only the cell whose store version moved", () => {
    const h = harness()
    const first = h.cache.read(["a", "b", "c"], h.readers)
    h.cells.set("b", cell("b", "validated", "draft"))
    h.versions.set("b", 2)

    const second = h.cache.read(["a", "b", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(1)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1].rawScore).toBe(100)
    expect(second[2]).toBe(first[2])
  })

  it("re-derives a cell when its health estimate changes", () => {
    const h = harness()
    const first = h.cache.read(["a", "b", "c"], h.readers)
    h.health.set("b", 75)

    const second = h.cache.read(["a", "b", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(1)
    expect(second[1]).not.toBe(first[1])
    expect(second[1].rawScore).toBe(75)
  })

  it("re-derives a cell when its examples array is replaced", () => {
    const h = harness()
    const first = h.cache.read(["a", "b", "c"], h.readers)
    h.examples.set("c", [{ matchedTokens: ["source"] }])

    const second = h.cache.read(["a", "b", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(1)
    expect(second[2]).not.toBe(first[2])
    expect(second[2].rawScore).toBe(50)
  })

  it("follows the id list: dropped ids are forgotten, new ids are built", () => {
    const h = harness()
    h.cache.read(["a", "b", "c"], h.readers)
    h.cache.read(["a", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(0)

    h.cache.read(["a", "b", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(1)
  })

  it("clear() rebuilds everything on the next read", () => {
    const h = harness()
    h.cache.read(["a", "b", "c"], h.readers)
    h.cache.clear()
    h.cache.read(["a", "b", "c"], h.readers)
    expect(h.cache.lastRebuilt).toBe(3)
  })
})

describe("ribbonInputCacheFor", () => {
  it("returns one cache per store and a different cache for another store", () => {
    const storeA = {}
    const storeB = {}
    expect(ribbonInputCacheFor(storeA)).toBe(ribbonInputCacheFor(storeA))
    expect(ribbonInputCacheFor(storeA)).not.toBe(ribbonInputCacheFor(storeB))
  })
})

describe("ribbon point stability", () => {
  it("keeps point identity for cells whose ribbon values did not change", () => {
    const versions = new Map<string, number>([["a", 1], ["b", 1], ["c", 1], ["d", 1]])
    const health = new Map<string, number>([["a", 40], ["b", 60], ["c", 80], ["d", 20]])
    const cells = new Map<string, TestCell>(
      ["a", "b", "c", "d"].map((id) => [id, cell(id, "unvalidated", "draft", { group: id === "d" ? "GEN 2" : "GEN 1" })]),
    )
    const readers = {
      getCellVersion: (id: string) => versions.get(id) ?? 0,
      getCell: (id: string) => cells.get(id) ?? null,
      sourceText: (c: TestCell) => c.original,
      health: (id: string) => health.get(id),
      examples: () => noExamples,
    }
    const cache = createRibbonInputCache()
    const first = cache.ribbon(["a", "b", "c", "d"], readers)
    const same = cache.ribbon(["a", "b", "c", "d"], readers)
    for (const id of ["a", "b", "c", "d"]) expect(same.get(id)).toBe(first.get(id))

    // A change in chapter 2 leaves every chapter-1 point untouched: the
    // smoother stops at scope boundaries, and so does the rendered blend
    // except for the row adjacent to the boundary.
    health.set("d", 90)
    const changed = cache.ribbon(["a", "b", "c", "d"], readers)
    expect(changed.get("a")).toBe(first.get("a"))
    expect(changed.get("b")).toBe(first.get("b"))
    expect(changed.get("d")).not.toBe(first.get("d"))
    expect(changed.get("d")?.rawScore).toBe(90)
  })

  it("stabilizeRibbonPoints swaps in the previous object only when every field matches", () => {
    const previous = new Map<string, HealthRibbonPoint>([
      ["a", { id: "a", stage: "automatic", rawScore: 50, smoothedScore: 50, evidenceWeight: 1 }],
      ["b", { id: "b", stage: "automatic", rawScore: 50, smoothedScore: 50, evidenceWeight: 1 }],
    ])
    const next = new Map<string, HealthRibbonPoint>([
      ["a", { id: "a", stage: "automatic", rawScore: 50, smoothedScore: 50, evidenceWeight: 1 }],
      ["b", { id: "b", stage: "automatic", rawScore: 51, smoothedScore: 50, evidenceWeight: 1 }],
    ])
    const result = stabilizeRibbonPoints(previous, next)
    expect(result.get("a")).toBe(previous.get("a"))
    expect(result.get("b")).toBe(next.get("b"))
  })
})
