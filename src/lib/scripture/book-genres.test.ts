import { describe, expect, it } from "vitest"
import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import { allBookGenres, BOOK_GENRES, bookGenre } from "./book-genres"

describe("bookGenre", () => {
  it("classifies a sample book from every genre", () => {
    expect(bookGenre("GEN")).toBe("law")
    expect(bookGenre("DEU")).toBe("law")
    expect(bookGenre("JOS")).toBe("history")
    expect(bookGenre("ACT")).toBe("history")
    expect(bookGenre("JOB")).toBe("wisdom")
    expect(bookGenre("PRO")).toBe("wisdom")
    expect(bookGenre("PSA")).toBe("poetry")
    expect(bookGenre("LAM")).toBe("poetry")
    expect(bookGenre("ISA")).toBe("prophecy")
    expect(bookGenre("MAL")).toBe("prophecy")
    expect(bookGenre("LUK")).toBe("gospel")
    expect(bookGenre("ROM")).toBe("epistle")
    expect(bookGenre("3JN")).toBe("epistle")
    expect(bookGenre("DAN")).toBe("apocalyptic")
    expect(bookGenre("REV")).toBe("apocalyptic")
  })

  it("is case-insensitive and trims whitespace", () => {
    expect(bookGenre("psa")).toBe("poetry")
    expect(bookGenre(" luk ")).toBe("gospel")
  })

  it("returns undefined for unknown codes and empty input", () => {
    expect(bookGenre("XYZ")).toBeUndefined()
    expect(bookGenre("TOB")).toBeUndefined() // deuterocanon is out of scope
    expect(bookGenre("")).toBeUndefined()
  })

  it("covers exactly the 66 canonical books, all with known codes and valid genres", () => {
    const map = allBookGenres()
    const codes = Object.keys(map)
    expect(codes).toHaveLength(66)
    for (const code of codes) {
      expect(isKnownBookCode(code), `${code} should be a known book code`).toBe(true)
      expect(BOOK_GENRES).toContain(map[code])
    }
    // Every genre in the taxonomy is actually used.
    expect(new Set(Object.values(map)).size).toBe(BOOK_GENRES.length)
  })
})
