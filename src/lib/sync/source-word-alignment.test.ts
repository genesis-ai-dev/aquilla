import { describe, expect, it } from "vitest"
import { chunkAlignment } from "./source-word-alignment"

const cell = (k: number, links: number) => ({
  cellId: `c${k}`,
  sourceHash: "aaaaaaaa",
  links: Array.from({ length: links }, (_, j) => ({ wordId: "n43004007011", token: j, conf: 0.5 })),
})

describe("splitting a book into writes the route accepts", () => {
  it("never puts more than 300 cells or 10,000 links in one write", () => {
    const chunks = chunkAlignment({ trainedPairs: 1149, cells: Array.from({ length: 1149 }, (_, k) => cell(k, 30)) })
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300)
      expect(chunk.reduce((n, c) => n + c.links.length, 0)).toBeLessThanOrEqual(10_000)
    }
    // Every cell goes, once, in order.
    expect(chunks.flat().map((c) => c.cellId)).toEqual(Array.from({ length: 1149 }, (_, k) => `c${k}`))
  })

  it("still sends one (empty) write for a book with nothing to align, so the run clears the old rows", () => {
    expect(chunkAlignment({ trainedPairs: 0, cells: [] })).toEqual([[]])
  })
})
