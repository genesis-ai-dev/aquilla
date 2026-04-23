import { describe, it, expect } from "vitest"
import { buildSectionIndex } from "./section-index"

describe("buildSectionIndex", () => {
  it("returns empty array for no cells", () => {
    expect(buildSectionIndex([])).toEqual([])
  })

  it("returns empty array when no cell has a section or globalReferences", () => {
    // Non-scripture file: group may hold an opaque split-tracking UUID — never a label.
    const cells = [
      { id: "a", group: "e7f3a9b4-..." },
      { id: "b", group: "8c12dd05-..." },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([])
  })

  it("derives section label from globalReferences (BOOK CH prefix)", () => {
    const cells = [
      { id: "a", group: "GEN", globalReferences: ["GEN 1:1"] },
      { id: "b", group: "GEN", globalReferences: ["GEN 1:2"] },
      { id: "c", group: "GEN", globalReferences: ["GEN 2:1"] },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "GEN 1", cellIds: ["a", "b"] },
      { label: "GEN 2", cellIds: ["c"] },
    ])
  })

  it("handles verse ranges — uses the first ref's chapter prefix", () => {
    const cells = [
      { id: "a", group: "LUK", globalReferences: ["LUK 1:1", "LUK 1:2"] },
      { id: "b", group: "LUK", globalReferences: ["LUK 1:3"] },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "LUK 1", cellIds: ["a", "b"] },
    ])
  })

  it("falls back to cell.section when globalReferences is absent (legacy docs)", () => {
    const cells = [
      { id: "a", group: "GEN", section: "GEN 1" },
      { id: "b", group: "GEN", section: "GEN 2" },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "GEN 1", cellIds: ["a"] },
      { label: "GEN 2", cellIds: ["b"] },
    ])
  })

  it("prefers globalReferences over section when both present", () => {
    const cells = [
      { id: "a", group: "GEN", section: "stale", globalReferences: ["GEN 1:1"] },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "GEN 1", cellIds: ["a"] },
    ])
  })

  it("never uses group as a label — group is opaque", () => {
    // Even if section is missing, group must never surface (for non-scripture files
    // it's a UUID tying split segments together, not a user-facing label).
    const cells = [
      { id: "a", group: "Chapter 1" },
      { id: "b", group: "Chapter 1" },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([])
  })

  it("mixes tagged + untagged cells — tagged bucket plus Ungrouped", () => {
    const cells = [
      { id: "a", group: "GEN", globalReferences: ["GEN 1:1"] },
      { id: "b", group: "split-uuid" },
      { id: "c", group: "GEN", globalReferences: ["GEN 1:2"] },
    ] as any[]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "GEN 1", cellIds: ["a", "c"] },
      { label: "Ungrouped", cellIds: ["b"] },
    ])
  })
})
