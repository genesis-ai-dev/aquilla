// AQU-1187: grouping a single file's chapters into books, so a whole-Bible
// import reads as Bible › book › chapter instead of one flat spine of 1,189
// rows. The rule that matters most is the NEGATIVE one: anything that is not a
// genuine multi-book scripture file must group to null and keep rendering flat.

import { describe, expect, it } from "vitest"
import { bookCodeFromChapterKey, bookOfChapter, groupChaptersByBook } from "./book-sections"

describe("bookCodeFromChapterKey", () => {
  it("reads the book out of a scripture milestone key", () => {
    expect(bookCodeFromChapterKey("scripture:GEN:1")).toBe("GEN")
    expect(bookCodeFromChapterKey("scripture:mat:5")).toBe("MAT")
  })

  it("returns undefined for keys that are not scripture chapters", () => {
    expect(bookCodeFromChapterKey("story:OBS:3")).toBeUndefined()
    expect(bookCodeFromChapterKey("part:2")).toBeUndefined()
    expect(bookCodeFromChapterKey("time:untimed")).toBeUndefined()
    // Shaped like a scripture key, but not a book we know.
    expect(bookCodeFromChapterKey("scripture:ZZZ:1")).toBeUndefined()
  })
})

describe("bookOfChapter", () => {
  it("falls back to the label when the key is the label (the /progress shape)", () => {
    expect(bookOfChapter({ key: "Genesis 1", label: "Genesis 1" })).toEqual({ id: "Genesis", ordinal: 0 })
    expect(bookOfChapter({ key: "1 Samuel 3", label: "1 Samuel 3" })?.id).toBe("1 Samuel")
  })

  it("normalizes code and name spellings onto one group", () => {
    const fromKey = bookOfChapter({ key: "scripture:GEN:2", label: "Genesis 2" })
    const fromLabel = bookOfChapter({ key: "GEN 2", label: "GEN 2" })
    expect(fromLabel?.id).toBe(fromKey?.id)
  })

  it("returns undefined for a label that names no book", () => {
    expect(bookOfChapter({ key: "part-3", label: "Part 3" })).toBeUndefined()
    expect(bookOfChapter({ key: "s", label: "Section" })).toBeUndefined()
  })
})

describe("groupChaptersByBook", () => {
  const chapter = (key: string, label: string) => ({ key, label })

  it("groups a multi-book file and orders the books canonically", () => {
    const groups = groupChaptersByBook([
      chapter("scripture:MAT:1", "Matthew 1"),
      chapter("scripture:GEN:1", "Genesis 1"),
      chapter("scripture:GEN:2", "Genesis 2"),
      chapter("scripture:EXO:1", "Exodus 1"),
    ])

    expect(groups?.map((group) => group.id)).toEqual(["Genesis", "Exodus", "Matthew"])
    expect(groups?.[0].chapters.map((c) => c.label)).toEqual(["Genesis 1", "Genesis 2"])
  })

  it("returns null for a single-book file — per-book files render flat as before", () => {
    expect(groupChaptersByBook([
      chapter("scripture:MRK:1", "Mark 1"),
      chapter("scripture:MRK:2", "Mark 2"),
    ])).toBeNull()
  })

  it("returns null when any chapter carries no book, rather than grouping part of the file", () => {
    expect(groupChaptersByBook([
      chapter("scripture:GEN:1", "Genesis 1"),
      chapter("scripture:MAT:1", "Matthew 1"),
      chapter("part:3", "Part 3"),
    ])).toBeNull()
  })

  it("returns null for non-scripture files (timeline, slides, parts)", () => {
    expect(groupChaptersByBook([
      chapter("time:0", "00:00–05:00"),
      chapter("time:1", "05:00–10:00"),
    ])).toBeNull()
    expect(groupChaptersByBook([])).toBeNull()
  })
})
