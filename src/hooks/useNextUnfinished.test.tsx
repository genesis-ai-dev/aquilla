import { describe, it, expect } from "vitest"
import { findNextUnfinishedIndex } from "./useNextUnfinished"

function mkCell(translated: string) {
  return { translated } as any
}

describe("findNextUnfinishedIndex", () => {
  it("returns -1 for empty list", () => {
    expect(findNextUnfinishedIndex([], 0)).toBe(-1)
  })

  it("returns -1 when every cell has target text", () => {
    const cells = [mkCell("done"), mkCell("done")]
    expect(findNextUnfinishedIndex(cells, 0)).toBe(-1)
  })

  it("finds the first untranslated cell after cursor", () => {
    const cells = [mkCell("done"), mkCell(""), mkCell("done")]
    expect(findNextUnfinishedIndex(cells, 0)).toBe(1)
  })

  // AQU-738: validation state must NOT make a cell a jump target. With cells
  // 0–4 translated-but-unvalidated and cell 5 empty, the jump skips straight
  // past the translated work to the genuinely empty cell.
  it("skips translated-but-unvalidated cells and lands on the empty one", () => {
    const cells = [
      mkCell("t1"),
      mkCell("t2"),
      mkCell("t3"),
      mkCell("t4"),
      mkCell("t5"),
      mkCell(""),
    ]
    expect(findNextUnfinishedIndex(cells, 0)).toBe(5)
  })

  it("counts a whitespace-only target as unfinished", () => {
    const cells = [mkCell("done"), mkCell("   \n\t"), mkCell("done")]
    expect(findNextUnfinishedIndex(cells, 0)).toBe(1)
  })

  it("wraps to start when nothing unfinished after cursor", () => {
    const cells = [mkCell(""), mkCell("done"), mkCell("done")]
    expect(findNextUnfinishedIndex(cells, 1)).toBe(0)
  })

  it("returns -1 when cursor is on the only unfinished cell and nothing else is unfinished", () => {
    const cells = [mkCell("done"), mkCell(""), mkCell("done")]
    expect(findNextUnfinishedIndex(cells, 1)).toBe(-1)
  })
})
