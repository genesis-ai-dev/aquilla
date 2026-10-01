import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  draftingUnitsFor,
  ensureSeamsForFile,
  getCachedSeam,
  hydrateSeams,
  __resetSeamCache,
  __clearPersistedSeams,
  type ClassifiedSeam,
  type SeamStoreCell,
} from "./seam-store"
import { seamKey } from "./seams"
import type { SeamWindowCell } from "./seam-request"

const cell = (
  id: string,
  text: string,
  overrides: Partial<SeamStoreCell> = {},
): SeamStoreCell => ({
  id,
  fileId: "f1",
  sourceEventId: `e-${id}`,
  text,
  ...overrides,
})

/** A classifier that joins every seam it is asked about, with high confidence. */
function joinAll() {
  return vi.fn(async (window: SeamWindowCell[]): Promise<ClassifiedSeam[]> => {
    const out: ClassifiedSeam[] = []
    for (let i = 0; i < window.length - 1; i++) {
      out.push({
        join: true,
        joinProbability: 0.92,
        confidence: 0.9,
        decidedBy: "model",
        boundaryLevel: 0,
        prevCellId: window[i].id,
        nextCellId: window[i + 1].id,
      })
    }
    return out
  })
}

beforeEach(async () => {
  await __clearPersistedSeams()
})

describe("draftingUnitsFor — the hot path", () => {
  it("falls back to punctuation on a cold cache, with no await", () => {
    // Drafting must never wait on classification. On a cold cache the answer is
    // the heuristic's, computed synchronously.
    const units = draftingUnitsFor([
      cell("a", "And when he had finished speaking, he said"),
      cell("b", "to Simon, Put out into the deep."),
      cell("c", "Simon answered him."),
    ])
    expect(units.map((u) => u.ids)).toEqual([["a", "b"], ["c"]])
  })

  it("uses cached answers once they exist", async () => {
    const cells = [
      cell("a", "He went home."), // punctuation alone would BREAK here
      cell("b", "There he waited."),
    ]
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)

    expect(draftingUnitsFor(cells).map((u) => u.ids)).toEqual([["a", "b"]])
  })

  it("never groups across a file boundary even with a cached join", async () => {
    const cells = [cell("a", "he said"), cell("b", "to Simon.", { fileId: "f2" })]
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)
    expect(draftingUnitsFor(cells).map((u) => u.ids)).toEqual([["a"], ["b"]])
  })
})

describe("ensureSeamsForFile", () => {
  it("does nothing for a file with no seam", async () => {
    const fn = joinAll()
    await ensureSeamsForFile([cell("a", "alone")], fn)
    expect(fn).not.toHaveBeenCalled()
  })

  it("caches one entry per seam, keyed on both source event ids", async () => {
    const cells = [cell("a", "one,"), cell("b", "two,"), cell("c", "three.")]
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)

    expect(getCachedSeam(seamKey("e-a", "e-b")!)).toMatchObject({ join: true, decidedBy: "model" })
    expect(getCachedSeam(seamKey("e-b", "e-c")!)).toMatchObject({ join: true })
  })

  it("skips the call entirely when every seam is already cached", async () => {
    const cells = [cell("a", "one,"), cell("b", "two.")]
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)
    expect(fn).toHaveBeenCalledTimes(1)

    await ensureSeamsForFile(cells, fn)
    // Reopening an unchanged file must cost nothing. This is the whole point of
    // keying on event ids rather than on a file version.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("re-classifies only the window holding an edited cell", async () => {
    const cells = [cell("a", "one,"), cell("b", "two,"), cell("c", "three.")]
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)

    // Editing b mints a new source event id. Its two seams miss; a->b and b->c
    // are in the same window here, so exactly one call re-runs — and the
    // untouched (a, old-b) entry is still in the cache, not swept.
    const edited = [cells[0], { ...cells[1], sourceEventId: "e-b2" }, cells[2]]
    await ensureSeamsForFile(edited, fn)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(getCachedSeam(seamKey("e-a", "e-b2")!)).toBeDefined()
    expect(getCachedSeam(seamKey("e-a", "e-b")!)).toBeDefined()
  })

  it("windows a long file with one cell of overlap so no seam is lost", async () => {
    // 90 cells = 89 seams, past the 40-seam request cap. Every seam must still
    // end up classified: dropping the ones at the window edges would leave
    // silent punctuation-only gaps in the middle of a file.
    const cells = Array.from({ length: 90 }, (_, i) => cell(`c${i}`, `line ${i},`))
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)

    expect(fn.mock.calls.length).toBeGreaterThan(1)
    for (let i = 0; i < cells.length - 1; i++) {
      expect(getCachedSeam(seamKey(`e-c${i}`, `e-c${i + 1}`)!)).toBeDefined()
    }
  })

  it("never asks about a seam it cannot cache", async () => {
    // A locally-created cell has no source event id yet. Spending a call on a
    // seam whose answer cannot be stored would re-spend it on every open.
    const cells = [
      cell("a", "one,", { sourceEventId: null }),
      cell("b", "two.", { sourceEventId: null }),
    ]
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)
    expect(fn).not.toHaveBeenCalled()
  })

  it("swallows a classifier failure and leaves the heuristic in charge", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const cells = [cell("a", "he said"), cell("b", "to Simon.")]
    const failing = vi.fn(async (): Promise<ClassifiedSeam[]> => { throw new Error("upstream down") })

    await expect(ensureSeamsForFile(cells, failing)).resolves.toBeUndefined()
    // Still groups — on punctuation, because "he said" has no final stop.
    expect(draftingUnitsFor(cells).map((u) => u.ids)).toEqual([["a", "b"]])
    warn.mockRestore()
  })

  it("ignores a returned seam naming cells outside the window", async () => {
    // A malformed response must not write a cache entry under a key derived
    // from cells the caller never sent.
    const cells = [cell("a", "one,"), cell("b", "two.")]
    const liar = vi.fn(async (): Promise<ClassifiedSeam[]> => [{
      join: true, joinProbability: 1, confidence: 1, decidedBy: "model", boundaryLevel: 0,
      prevCellId: "somewhere", nextCellId: "else",
    }])
    await ensureSeamsForFile(cells, liar)
    expect(getCachedSeam(seamKey("e-a", "e-b")!)).toBeUndefined()
  })

  it("survives a reload — answers come back from IndexedDB", async () => {
    const cells = [cell("a", "He went home."), cell("b", "There he waited.")]
    const fn = joinAll()
    await ensureSeamsForFile(cells, fn)

    // Simulate a fresh page load: memory mirror gone, IDB intact.
    __resetSeamCache()
    expect(getCachedSeam(seamKey("e-a", "e-b")!)).toBeUndefined()

    await hydrateSeams([seamKey("e-a", "e-b")!])
    expect(getCachedSeam(seamKey("e-a", "e-b")!)).toMatchObject({ join: true })
    expect(draftingUnitsFor(cells).map((u) => u.ids)).toEqual([["a", "b"]])
  })
})
