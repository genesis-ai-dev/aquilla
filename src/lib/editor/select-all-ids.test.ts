import { describe, expect, it } from "vitest"

import { idsForSelectAll } from "./select-all-ids"

describe("idsForSelectAll", () => {
  const book = ["a", "b", "c", "d"]
  const filtered = ["b", "d"]

  it("selects the whole file, the milestone page, or the filtered rows", () => {
    const chapter = ["a", "b"]
    const cases: {
      name: string
      fileIds: readonly string[]
      filteredIds: readonly string[] | null
      milestoneIds: readonly string[] | null
      want: readonly string[]
    }[] = [
      { name: "the whole file", fileIds: book, filteredIds: null, milestoneIds: null, want: book },
      { name: "the milestone on the page", fileIds: book, filteredIds: null, milestoneIds: chapter, want: chapter },
      { name: "an empty milestone page", fileIds: book, filteredIds: null, milestoneIds: [], want: [] },
      { name: "a filter lists a subset", fileIds: book, filteredIds: filtered, milestoneIds: null, want: filtered },
      { name: "a filter wins over the milestone page", fileIds: book, filteredIds: filtered, milestoneIds: chapter, want: filtered },
      { name: "a filter matches nothing", fileIds: book, filteredIds: [], milestoneIds: chapter, want: [] },
      { name: "an empty file", fileIds: [], filteredIds: null, milestoneIds: null, want: [] },
    ]
    for (const entry of cases) {
      expect(idsForSelectAll({
        fileIds: entry.fileIds,
        filteredIds: entry.filteredIds,
        milestoneIds: entry.milestoneIds,
      }), entry.name).toEqual(entry.want)
    }
  })
})
