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

  it("prefers cell.section over cell.group when both are present", () => {
    const cells = [
      { id: "a", group: "uuid-1", section: "GEN 1" },
      { id: "b", group: "uuid-2", section: "GEN 1" },
      { id: "c", group: "uuid-3", section: "GEN 2" },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "GEN 1", cellIds: ["a", "b"] },
      { label: "GEN 2", cellIds: ["c"] },
    ])
  })

  it("falls back to group when section is missing or empty", () => {
    const cells = [
      { id: "a", group: "G1", section: "" },
      { id: "b", group: "G1" },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "G1", cellIds: ["a", "b"] },
    ])
  })
})
