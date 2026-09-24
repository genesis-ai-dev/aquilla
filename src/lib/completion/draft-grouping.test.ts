import { describe, it, expect, beforeEach } from "vitest"
import { fixedSlices, packSelectionIntoCalls, type GroupingCell } from "./draft-grouping"
import { ensureSeamsForFile, __clearPersistedSeams, type ClassifiedSeam } from "./seam-store"
import type { SeamWindowCell } from "./seam-request"

const cell = (id: string, text: string, fileId = "f1"): GroupingCell => ({
  id, fileId, sourceEventId: `e-${id}`, text,
})

/** Cache a model "join" for exactly the named adjacent pairs. */
async function cacheJoins(corpus: GroupingCell[], joined: string[]): Promise<void> {
  await ensureSeamsForFile(corpus, async (window: SeamWindowCell[]) => {
    const out: ClassifiedSeam[] = []
    for (let i = 0; i < window.length - 1; i++) {
      const pair = `${window[i].id}->${window[i + 1].id}`
      const join = joined.includes(pair)
      out.push({
        join,
        joinProbability: join ? 0.9 : 0.05,
        confidence: 0.9,
        decidedBy: "model",
        boundaryLevel: join ? 0 : 3,
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

describe("fixedSlices", () => {
  it("reproduces today's fixed chunking exactly", () => {
    expect(fixedSlices([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it("returns nothing for a non-positive budget", () => {
    expect(fixedSlices([1, 2], 0)).toEqual([])
  })
})

describe("packSelectionIntoCalls", () => {
  // A file where cells 2-3 and 5-6-7 are each one thought.
  const corpus = [
    cell("c1", "He went home."),
    cell("c2", "And when he had finished speaking, he said"),
    cell("c3", "to Simon, Put out into the deep."),
    cell("c4", "Simon answered him."),
    cell("c5", "Master, we worked all night"),
    cell("c6", "and caught nothing; but at your word"),
    cell("c7", "I will let down the net."),
    cell("c8", "A new section begins."),
  ]
  const joins = ["c2->c3", "c5->c6", "c6->c7"]

  it("keeps a whole unit in one call", async () => {
    await cacheJoins(corpus, joins)
    const calls = packSelectionIntoCalls(corpus, corpus, 10)
    const withC2 = calls.find((c) => c.includes("c2"))
    expect(withC2).toContain("c3")
  })

  it("never splits a unit across the budget boundary", async () => {
    await cacheJoins(corpus, joins)
    // Budget 3: c5-c6-c7 is exactly 3, so it must land alone rather than
    // starting at the tail of the previous call.
    const calls = packSelectionIntoCalls(corpus, corpus, 3)
    expect(calls).toContainEqual(["c5", "c6", "c7"])
  })

  it("does NOT join two selected cells that are not adjacent in the file", async () => {
    // The trap this module exists for. c3 and c5 are both selected but c4 sits
    // between them in the file, so there is no seam to join across — even
    // though c3's neighbour-by-selection ends mid-thought.
    await cacheJoins(corpus, [...joins, "c3->c5"])
    // Budget 2 is what makes this discriminating: separate units may share a
    // call when they fit, so only a boundary tight enough to force a split
    // reveals whether c3 and c5 landed in the same UNIT.
    const calls = packSelectionIntoCalls(
      [corpus[2], corpus[4], corpus[5]], // c3, c5, c6
      corpus,
      2,
    )
    expect(calls).toEqual([["c3"], ["c5", "c6"]])
  })

  it("drafts a partly-selected unit without dragging in the unselected rest", async () => {
    // Batch drafting honours the selection. Expanding to the whole unit is the
    // single-cell sparkle's contract, not multi-select's — silently drafting
    // cells the user did not pick is a different surprise.
    await cacheJoins(corpus, joins)
    const calls = packSelectionIntoCalls([corpus[4], corpus[5]], corpus, 10) // c5, c6
    expect(calls).toEqual([["c5", "c6"]])
  })

  it("treats a cell missing from the corpus as its own unit", async () => {
    await cacheJoins(corpus, joins)
    const stray = cell("zz", "not in this file,")
    const calls = packSelectionIntoCalls([stray, corpus[0]], corpus, 1)
    expect(calls).toEqual([["zz"], ["c1"]])
  })

  it("loses no cell and preserves selection order", async () => {
    await cacheJoins(corpus, joins)
    expect(packSelectionIntoCalls(corpus, corpus, 3).flat())
      .toEqual(corpus.map((c) => c.id))
  })

  it("falls back to punctuation grouping when nothing is cached", () => {
    // Cold cache: c2 has no sentence-final punctuation, so the heuristic still
    // joins it to c3. Drafting never waits for classification.
    const calls = packSelectionIntoCalls(corpus, corpus, 10)
    expect(calls.find((c) => c.includes("c2"))).toContain("c3")
  })

  it("returns nothing for an empty selection", () => {
    expect(packSelectionIntoCalls([], corpus, 10)).toEqual([])
  })
})
