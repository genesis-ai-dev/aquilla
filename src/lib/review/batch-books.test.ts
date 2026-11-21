import { describe, expect, it } from "vitest"
import { listBatchBooks } from "./batch-books"

describe("listBatchBooks", () => {
  it("keeps book files, in canonical order, and drops a file with no book code", () => {
    expect(listBatchBooks([
      { id: "notes", name: "Notes", bookCode: null },
      { id: "mat", name: "Matthew.usfm", bookCode: "MAT" },
      { id: "gen", name: "Genesis.usfm", bookCode: "gen" },
      { id: "plain", name: "Minutes" },
    ]).map((book) => book.name)).toEqual(["Genesis", "Matthew"])
  })

  it("names both files when one book was imported twice", () => {
    const books = listBatchBooks([
      { id: "a", name: "Jonah (draft)", bookCode: "JON" },
      { id: "b", name: "Jonah (final)", bookCode: "JON" },
    ])
    expect(books.map((book) => book.name)).toEqual(["Jonah (draft)", "Jonah (final)"])
  })
})
