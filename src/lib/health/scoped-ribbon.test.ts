import { describe, expect, it, vi } from "vitest"
import { createScopedRibbonCache } from "./scoped-ribbon"
import { ribbonInputFor, type RibbonInputCell } from "./ribbon-inputs"
import { buildHealthRibbon } from "./health-ribbon"

function fixture(count: number, scoped = true) {
  const ids = Array.from({ length: count }, (_, i) => String(i))
  const cells = new Map(ids.map((id, i) => [id, {
    id, fileId: "f", group: scoped ? `chapter-${Math.floor(i / 26)}` : undefined,
    status: i % 7 === 0 ? "validated" : i % 5 === 0 ? "empty" : "unvalidated",
    translated: i % 5 === 0 ? "" : "translation",
  } satisfies RibbonInputCell]))
  const readers = {
    getCellVersion: () => 1,
    getCell: vi.fn((id: string) => cells.get(id) ?? null),
    sourceText: () => "source text",
    health: (id: string) => Number(id) % 11 === 0 ? undefined : Number(id) * 37 % 130,
    examples: (id: string) => Number(id) % 2 ? [{ matchedTokens: ["source"] }] : [],
  }
  return { ids, cells, readers }
}
const indices = (ids: string[]) => new Map(ids.map((id, i) => [id, i]))

describe("scoped ribbon", () => {
  it.each([true, false])("exactly matches whole-file smoothing, scopes=%s", scoped => {
    const { ids, readers } = fixture(201, scoped)
    const expected = buildHealthRibbon(ids.map(id => ribbonInputFor(id, readers.getCell(id), readers)))
    const lazy = createScopedRibbonCache().read(ids, indices(ids), readers)
    // Visit scopes out of order, including ends and all seams.
    for (const id of [...ids].reverse()) expect(lazy.get(id)).toEqual(expected.get(id))
    expect(lazy.get("missing")).toBeUndefined()
  })

  it("preserves full neighboring-scope influence across long scored runs", () => {
    const { ids, readers, cells } = fixture(300)
    for (const [id, cell] of cells) cells.set(id, {
      ...cell, status: "unvalidated", translated: "draft",
      group: Number(id) < 100 || Number(id) >= 200 ? "repeated-scope" : "middle",
    })
    const scored = { ...readers, health: (id: string) => Number(id) % 97 }
    const full = buildHealthRibbon(ids.map(id => ribbonInputFor(id, scored.getCell(id), scored)))
    const lazy = createScopedRibbonCache().read(ids, indices(ids), scored)
    for (const id of ["100", "199", "200", "99", "0", "299"]) {
      expect(lazy.get(id)).toEqual(full.get(id))
    }
  })

  it("does no eager cell work and bounds reads to the requested scope and neighbors", () => {
    const { ids, readers } = fixture(31_215)
    const lazy = createScopedRibbonCache().read(ids, indices(ids), readers)
    expect(readers.getCell).not.toHaveBeenCalled()
    lazy.get("260")
    expect(readers.getCell.mock.calls.length).toBeLessThanOrEqual(80)
    const calls = readers.getCell.mock.calls.length
    lazy.get("270")
    expect(readers.getCell).toHaveBeenCalledTimes(calls)
  })

  it("reuses unsectioned document inputs across unchanged refreshes", () => {
    const { ids, readers } = fixture(100, false)
    const noExamples: Array<{ matchedTokens: string[] }> = []
    readers.examples = () => noExamples
    const cache = createScopedRibbonCache()
    const first = cache.read(ids, indices(ids), readers).get("27")
    readers.getCell.mockClear()
    const next = cache.read(ids, indices(ids), readers).get("27")
    expect(next).toBe(first)
    expect(readers.getCell).not.toHaveBeenCalled()
  })

  it("refreshes scores, stages, membership and order without mutating old points", () => {
    const { ids, readers, cells } = fixture(110)
    const cache = createScopedRibbonCache()
    const first = cache.read(ids, indices(ids), readers)
    const old = first.get("27")!
    const oldSnapshot = { ...old }
    const same = cache.read(ids, indices(ids), readers)
    expect(same.get("27")).toBe(old)
    cells.set("27", { ...cells.get("27")!, status: "validated", translated: "updated", group: "changed" })
    cells.delete("28")
    const reordered = [...ids.slice(50), ...ids.slice(0, 50)].filter(id => id !== "29")
    const updatedReaders = { ...readers, getCellVersion: () => 2, health: () => 72 }
    const next = cache.read(reordered, indices(reordered), updatedReaders)
    const full = buildHealthRibbon(reordered.map(id => ribbonInputFor(id, readers.getCell(id), updatedReaders)))
    for (const id of reordered) expect(next.get(id)).toEqual(full.get(id))
    expect(next.get("29")).toBeUndefined()
    expect(old).toEqual(oldSnapshot)
    expect(cache.read([], new Map(), readers).get("27")).toBeUndefined()
  })
})
