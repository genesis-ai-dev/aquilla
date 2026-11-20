import { describe, expect, it } from "vitest"

import { idsForSelectAll } from "./select-all-ids"

describe("idsForSelectAll", () => {
  const book = ["a", "b", "c", "d"]
  const filtered = ["b", "d"]

  it("selects the whole file, or the filtered rows", () => {
    const cases: { name: string; fileIds: readonly string[]; filteredIds: readonly string[] | null; want: readonly string[] }[] = [
      { name: "the whole file", fileIds: book, filteredIds: null, want: book },
      { name: "a filter lists a subset", fileIds: book, filteredIds: filtered, want: filtered },
      { name: "a filter matches nothing", fileIds: book, filteredIds: [], want: [] },
      { name: "an empty file", fileIds: [], filteredIds: null, want: [] },
    ]
    for (const entry of cases) {
      expect(idsForSelectAll({
        fileIds: entry.fileIds,
        filteredIds: entry.filteredIds,
      }), entry.name).toEqual(entry.want)
    }
  })
})
