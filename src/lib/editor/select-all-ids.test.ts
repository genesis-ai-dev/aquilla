import { describe, expect, it } from "vitest"

import { idsForSelectAll } from "./select-all-ids"

describe("idsForSelectAll", () => {
  const book = ["a", "b", "c", "d"]
  const chapter = ["b", "c"]

  it("picks the chapter, the filter, or the whole list", () => {
    const cases: { name: string; filtered: boolean; chapterIds: readonly string[] | null; want: readonly string[] }[] = [
      { name: "the chapter on screen", filtered: false, chapterIds: chapter, want: chapter },
      { name: "a filter lists a subset", filtered: true, chapterIds: chapter, want: book },
      { name: "a file with no chapter", filtered: false, chapterIds: null, want: book },
      { name: "an empty list", filtered: false, chapterIds: chapter, want: [] },
    ]
    for (const entry of cases) {
      const displayedIds = entry.name === "an empty list" ? [] : book
      expect(idsForSelectAll({
        displayedIds,
        filtered: entry.filtered,
        chapterIds: entry.chapterIds,
      }), entry.name).toEqual(entry.want)
    }
  })
})
