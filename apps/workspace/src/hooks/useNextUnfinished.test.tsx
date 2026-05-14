import { describe, it, expect } from "vitest"
import { findNextUnfinishedIndex } from "./useNextUnfinished"

function mkCell(translated: string, validators: string[]) {
  return { translated, activeValidators: validators } as any
}

describe("findNextUnfinishedIndex", () => {
  it("returns -1 for empty list", () => {
    expect(findNextUnfinishedIndex([], 0, 1)).toBe(-1)
  })

  it("returns -1 when everything is finished", () => {
    const cells = [
      mkCell("done", ["a"]),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 0, 1)).toBe(-1)
  })

  it("finds the first untranslated cell after cursor", () => {
    const cells = [
      mkCell("done", ["a"]),
      mkCell("", []),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 0, 1)).toBe(1)
  })

  it("finds the first cell below threshold after cursor", () => {
    const cells = [
      mkCell("done", ["a", "b"]),
      mkCell("done", ["a"]),          // below threshold of 2
      mkCell("done", ["a", "b"]),
    ]
    expect(findNextUnfinishedIndex(cells, 0, 2)).toBe(1)
  })

  it("wraps to start when nothing unfinished after cursor", () => {
    const cells = [
      mkCell("", []),                 // unfinished at 0
      mkCell("done", ["a"]),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 1, 1)).toBe(0)
  })

  it("returns -1 when cursor is on the only unfinished cell and nothing else is unfinished", () => {
    const cells = [
      mkCell("done", ["a"]),
      mkCell("", []),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 1, 1)).toBe(-1)
  })
})
