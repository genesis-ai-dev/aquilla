import { describe, it, expect } from "vitest"
import {
  chapterFilenameSuffix,
  chapterLabelForCell,
  filterCellsByChapter,
  listChapterLabels,
  looksLikeChapter,
} from "./chapter-scope"

/** A cell is only ever read through `group` here. */
const cell = (group: string) => ({ group })

describe("chapterLabelForCell", () => {
  it("derives the chapter from a verse ref", () => {
    expect(chapterLabelForCell(cell("GEN 1:1"))).toBe("GEN 1")
    expect(chapterLabelForCell(cell("1CO 13:4"))).toBe("1CO 13")
  })

  it("keeps a ref that is already the chapter (a heading cell)", () => {
    expect(chapterLabelForCell(cell("GEN 1"))).toBe("GEN 1")
  })

  it("handles a verse range", () => {
    expect(chapterLabelForCell(cell("GEN 1:1-2"))).toBe("GEN 1")
  })

  it("returns nothing for a cell with no ref", () => {
    expect(chapterLabelForCell(cell(""))).toBe("")
    expect(chapterLabelForCell({ group: undefined as unknown as string })).toBe("")
  })

  it("rejects refs that are not chapters — a uuid or a timecode", () => {
    expect(chapterLabelForCell(cell("550e8400-e29b-41d4-a716-446655440000"))).toBe("")
    expect(chapterLabelForCell(cell("00:00:12.500"))).toBe("")
  })
})

describe("looksLikeChapter", () => {
  it("admits real milestone labels", () => {
    expect(looksLikeChapter("GEN 1")).toBe(true)
    expect(looksLikeChapter("Story 4")).toBe(true)
    expect(looksLikeChapter("Rev. 22")).toBe(true)
  })

  it("rejects a bare number, a bare name, and an implausible chapter", () => {
    expect(looksLikeChapter("1")).toBe(false)
    expect(looksLikeChapter("GEN")).toBe(false)
    expect(looksLikeChapter("GEN 1000")).toBe(false)
  })
})

describe("listChapterLabels", () => {
  it("lists distinct chapters in document order, not sorted", () => {
    const cells = [
      cell("GEN 2:1"),
      cell("GEN 2:2"),
      cell("GEN 10:1"),
      cell("GEN 10:2"),
      cell("GEN 11:1"),
    ]
    expect(listChapterLabels(cells)).toEqual(["GEN 2", "GEN 10", "GEN 11"])
  })

  it("skips cells with no chapter", () => {
    expect(listChapterLabels([cell(""), cell("GEN 1:1"), cell("00:00:01.000")]))
      .toEqual(["GEN 1"])
  })

  it("returns nothing for a file with no chapter refs at all", () => {
    expect(listChapterLabels([cell(""), cell("")])).toEqual([])
  })
})

describe("filterCellsByChapter", () => {
  const cells = [cell("GEN 1"), cell("GEN 1:1"), cell("GEN 2:1"), cell("")]

  it("keeps only the chosen chapter, heading cell included", () => {
    expect(filterCellsByChapter(cells, "GEN 1")).toEqual([cell("GEN 1"), cell("GEN 1:1")])
  })

  it("drops cells that belong to no chapter", () => {
    expect(filterCellsByChapter(cells, "GEN 2")).toEqual([cell("GEN 2:1")])
  })

  it("returns everything untouched when no chapter is chosen", () => {
    expect(filterCellsByChapter(cells, "")).toBe(cells)
  })
})

describe("chapterFilenameSuffix", () => {
  it("makes a chapter safe for a filename", () => {
    expect(chapterFilenameSuffix("GEN 1")).toBe("_GEN-1")
    expect(chapterFilenameSuffix("1 Corinthians 13")).toBe("_1-Corinthians-13")
  })

  it("is empty when no chapter is chosen", () => {
    expect(chapterFilenameSuffix("")).toBe("")
  })
})
