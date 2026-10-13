import { describe, expect, it } from "vitest"
import { alignableCells, readyStatus } from "./source-alignment-store"

const cell = (cellId: string, canonicalRef: string | null, value = "Jesus said to her.", type: string | null = "text") => ({
  cellId,
  canonicalRef,
  value,
  type,
})

describe("the cells a run aligns", () => {
  it("takes whole verses and bridges of the book, and nothing else", () => {
    const cells = alignableCells(
      [
        cell("c1", "JHN 4:7"),
        cell("c2", "JHN 4:8-9"),
        cell("heading", "JHN 4:7", "Jesus Talks with a Samaritan Woman", "heading"),
        cell("partial", "JHN 4:10a"),
        cell("other-book", "MRK 1:29"),
        cell("empty", "JHN 4:11", "   "),
      ],
      "JHN",
    )
    expect(cells).toEqual([
      { cellId: "c1", refs: ["JHN 4:7"], text: "Jesus said to her." },
      { cellId: "c2", refs: ["JHN 4:8", "JHN 4:9"], text: "Jesus said to her." },
    ])
  })

  it("leaves out a verse split across cells: neither half has the verse's Greek to itself", () => {
    const cells = alignableCells([cell("a", "JHN 4:7"), cell("b", "JHN 4:7"), cell("c", "JHN 4:8")], "JHN")
    expect(cells.map((c) => c.cellId)).toEqual(["c"])
  })
})

describe("stored rows as the editor reads them", () => {
  it("keeps current cells' links and counts the stale ones", () => {
    const status = readyStatus([
      { cellId: "c1", sourceHash: "aaaaaaaa", method: "m", trainedPairs: 878, stale: false, links: [["n43004007011", 8, 0.79]] },
      { cellId: "c2", sourceHash: "bbbbbbbb", method: "m", trainedPairs: 878, stale: true, links: [] },
    ])
    expect(status.kind).toBe("ready")
    if (status.kind !== "ready") return
    expect(status.staleCells).toBe(1)
    expect(status.trainedPairs).toBe(878)
    expect([...status.cells.keys()]).toEqual(["c1"])
    expect(status.cells.get("c1")).toEqual({
      sourceHash: "aaaaaaaa",
      trainedPairs: 878,
      links: [{ wordId: "n43004007011", token: 8, conf: 0.79 }],
    })
  })

  it("has no training size when nothing is aligned", () => {
    expect(readyStatus([])).toEqual({ kind: "ready", cells: new Map(), staleCells: 0, trainedPairs: null })
  })
})
