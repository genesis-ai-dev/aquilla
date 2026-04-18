import { describe, it, expect } from "vitest"
import { buildSectionIndex } from "./section-index"

function mkCell(id: string, group: string) {
  return { id, group } as any
}

describe("buildSectionIndex", () => {
  it("returns empty array for no cells", () => {
    expect(buildSectionIndex([])).toEqual([])
  })
  it("groups cells by group field preserving first-seen order", () => {
    const cells = [
      mkCell("a", "Chapter 1"),
      mkCell("b", "Chapter 1"),
      mkCell("c", "Chapter 2"),
      mkCell("d", "Chapter 1"),
    ]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "Chapter 1", cellIds: ["a", "b", "d"] },
      { label: "Chapter 2", cellIds: ["c"] },
    ])
  })
  it("falls back to 'Ungrouped' for missing or empty group", () => {
    const cells = [
      mkCell("a", ""),
      mkCell("b", "Chapter 1"),
      mkCell("c", ""),
    ]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "Ungrouped", cellIds: ["a", "c"] },
      { label: "Chapter 1", cellIds: ["b"] },
    ])
  })
  it("treats undefined group as Ungrouped", () => {
    const cells = [{ id: "a" }, { id: "b", group: "X" }] as any
    expect(buildSectionIndex(cells)).toEqual([
      { label: "Ungrouped", cellIds: ["a"] },
      { label: "X", cellIds: ["b"] },
    ])
  })
})
