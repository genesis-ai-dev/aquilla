// Unit tests for the AD-13 passage-expansion module.

import { describe, it, expect } from "vitest"
import {
  expandPassage,
  expandToPassages,
} from "../lib/branching-search/passages"
import type { CorpusCell } from "../lib/branching-search/algorithm"

// Build a 6-cell anchor chain in one file:
//   c1 ← c2 ← c3 ← c4 ← c5 ← c6
// (each cell's anchorCellId points back at its predecessor)
const FILE_F1: CorpusCell[] = [
  { cellId: "c1", fileId: "f1", anchorCellId: null, sourceText: "alpha", targetText: "A" },
  { cellId: "c2", fileId: "f1", anchorCellId: "c1", sourceText: "beta", targetText: "B" },
  { cellId: "c3", fileId: "f1", anchorCellId: "c2", sourceText: "gamma", targetText: "C" },
  { cellId: "c4", fileId: "f1", anchorCellId: "c3", sourceText: "delta", targetText: "D" },
  { cellId: "c5", fileId: "f1", anchorCellId: "c4", sourceText: "epsilon", targetText: "E" },
  { cellId: "c6", fileId: "f1", anchorCellId: "c5", sourceText: "zeta", targetText: "F" },
]

// Second-file chain to verify expansion never crosses files.
const FILE_F2: CorpusCell[] = [
  { cellId: "d1", fileId: "f2", anchorCellId: null, sourceText: "uno", targetText: "1" },
  { cellId: "d2", fileId: "f2", anchorCellId: "d1", sourceText: "dos", targetText: "2" },
]

const CORPUS = [...FILE_F1, ...FILE_F2]

describe("expandPassage", () => {
  it("returns null when the hit cell isn't in the corpus", () => {
    const result = expandPassage("missing", 2, {
      byCellId: new Map(),
      byAnchor: new Map(),
    })
    expect(result).toBeNull()
  })

  it("expands ±radius around a middle cell", () => {
    const passages = expandToPassages(CORPUS, ["c4"], 2)
    expect(passages.length).toBe(1)
    const p = passages[0]
    expect(p.fileId).toBe("f1")
    expect(p.hitCellId).toBe("c4")
    expect(p.cells.map((c) => c.cellId)).toEqual(["c2", "c3", "c4", "c5", "c6"])
    expect(p.cells.find((c) => c.hit)!.cellId).toBe("c4")
    expect(p.cells.filter((c) => c.hit).length).toBe(1)
  })

  it("truncates the back-walk at the file head", () => {
    const passages = expandToPassages(CORPUS, ["c2"], 3)
    const p = passages[0]
    // c1 is the file head (anchor=null); back walk yields only c1.
    expect(p.cells.map((c) => c.cellId)).toEqual(["c1", "c2", "c3", "c4", "c5"])
  })

  it("truncates the forward-walk at the file tail", () => {
    const passages = expandToPassages(CORPUS, ["c5"], 3)
    const p = passages[0]
    // c6 is the tail (no successor); forward walk yields only c6.
    expect(p.cells.map((c) => c.cellId)).toEqual(["c2", "c3", "c4", "c5", "c6"])
  })

  it("returns just the hit when radius is 0", () => {
    const passages = expandToPassages(CORPUS, ["c4"], 0)
    expect(passages[0].cells.map((c) => c.cellId)).toEqual(["c4"])
    expect(passages[0].cells[0].hit).toBe(true)
  })

  it("never crosses file boundaries", () => {
    // Cross-link c1 (f1) and d1 (f2) wouldn't be valid in real data, but
    // verify the file-id check by treating d1 as a hit and confirming the
    // back walk doesn't follow into f1.
    const corpus: CorpusCell[] = [
      { cellId: "c1", fileId: "f1", anchorCellId: null, sourceText: "a", targetText: "" },
      // Intentionally bogus: d1 anchored to c1 (would only happen if data is
      // corrupted). Expansion must refuse to cross.
      { cellId: "d1", fileId: "f2", anchorCellId: "c1", sourceText: "x", targetText: "" },
      { cellId: "d2", fileId: "f2", anchorCellId: "d1", sourceText: "y", targetText: "" },
    ]
    const passages = expandToPassages(corpus, ["d2"], 2)
    expect(passages[0].fileId).toBe("f2")
    expect(passages[0].cells.map((c) => c.cellId)).toEqual(["d1", "d2"])
  })

  it("preserves hit order across multiple hits", () => {
    const passages = expandToPassages(CORPUS, ["c3", "c5"], 1)
    expect(passages.map((p) => p.hitCellId)).toEqual(["c3", "c5"])
    expect(passages[0].cells.map((c) => c.cellId)).toEqual(["c2", "c3", "c4"])
    expect(passages[1].cells.map((c) => c.cellId)).toEqual(["c4", "c5", "c6"])
  })

  it("skips hits absent from the corpus silently", () => {
    const passages = expandToPassages(CORPUS, ["c2", "missing", "c5"], 0)
    expect(passages.map((p) => p.hitCellId)).toEqual(["c2", "c5"])
  })

  it("returns empty for empty inputs", () => {
    expect(expandToPassages([], ["c1"], 2)).toEqual([])
    expect(expandToPassages(CORPUS, [], 2)).toEqual([])
  })

  it("rejects negative radius", () => {
    expect(expandToPassages(CORPUS, ["c4"], -1)).toEqual([])
  })

  it("populates anchorCellId on every passage cell", () => {
    const passages = expandToPassages(CORPUS, ["c4"], 1)
    const cells = passages[0].cells
    expect(cells[0].anchorCellId).toBe("c2") // c3's anchor
    expect(cells[1].anchorCellId).toBe("c3") // c4's anchor
    expect(cells[2].anchorCellId).toBe("c4") // c5's anchor
  })
})
