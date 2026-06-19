import { describe, it, expect } from "vitest"
import { deriveParagraphs, paragraphGroupForCell } from "../paragraphs"
import type { ParagraphCell } from "../paragraphs"

const c = (id: string, fileId: string, paragraphStart?: boolean): ParagraphCell =>
  ({ id, fileId, ...(paragraphStart !== undefined ? { paragraphStart } : {}) })

describe("deriveParagraphs", () => {
  it("returns [] for an empty input", () => {
    expect(deriveParagraphs([])).toEqual([])
  })

  it("puts the very first cell in its own group even without paragraphStart", () => {
    const cells = [c("a", "f1"), c("b", "f1"), c("c", "f1")]
    const groups = deriveParagraphs(cells)
    expect(groups[0]).toContain("a")
  })

  it("groups cells correctly when some carry paragraphStart", () => {
    const cells = [
      c("a", "f1"),              // first → new group
      c("b", "f1"),              // continuation
      c("c", "f1", true),        // explicit paragraph break
      c("d", "f1"),              // continuation of new group
      c("e", "f1", true),        // another break
    ]
    const groups = deriveParagraphs(cells)
    expect(groups).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ])
  })

  it("a file boundary always starts a new group even without paragraphStart", () => {
    const cells = [
      c("a", "f1"),
      c("b", "f1"),
      c("c", "f2"),   // file boundary — must start a new group
      c("d", "f2"),
    ]
    const groups = deriveParagraphs(cells)
    expect(groups).toEqual([
      ["a", "b"],
      ["c", "d"],
    ])
  })

  it("file boundary + paragraphStart both trigger breaks independently", () => {
    const cells = [
      c("a", "f1"),
      c("b", "f1", true),   // explicit break within same file
      c("c", "f2"),          // file boundary
      c("d", "f2", true),   // explicit break in new file
    ]
    const groups = deriveParagraphs(cells)
    expect(groups).toEqual([["a"], ["b"], ["c"], ["d"]])
  })

  it("a single cell is its own paragraph", () => {
    expect(deriveParagraphs([c("x", "f1")])).toEqual([["x"]])
  })
})

describe("paragraphGroupForCell", () => {
  const cells = [
    c("a", "f1"),
    c("b", "f1"),
    c("c", "f1", true),  // new paragraph
    c("d", "f1"),
    c("e", "f2"),         // file boundary
  ]

  it("returns the correct group for the first cell", () => {
    expect(paragraphGroupForCell(cells, "a")).toEqual(["a", "b"])
  })

  it("returns the full group for a mid-paragraph cell", () => {
    expect(paragraphGroupForCell(cells, "b")).toEqual(["a", "b"])
  })

  it("returns the correct group for a paragraph-start cell", () => {
    expect(paragraphGroupForCell(cells, "c")).toEqual(["c", "d"])
  })

  it("returns [] for an unknown cellId", () => {
    expect(paragraphGroupForCell(cells, "unknown")).toEqual([])
  })

  it("returns a single-cell group at a file boundary", () => {
    expect(paragraphGroupForCell(cells, "e")).toEqual(["e"])
  })
})
