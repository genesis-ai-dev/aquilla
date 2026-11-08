import { describe, it, expect } from "vitest"
import { CANON_CHAPTERS, canonChapterCount } from "./canon-chapters"

describe("canon-chapters", () => {
  it("has the Protestant canon's 66 books and 1,189 chapters", () => {
    expect(CANON_CHAPTERS).toHaveLength(66)
    expect(CANON_CHAPTERS.reduce((sum, [, n]) => sum + n, 0)).toBe(1189)
  })

  it("reads a book's chapter count by code, in any case", () => {
    expect(canonChapterCount("PSA")).toBe(150)
    expect(canonChapterCount("psa")).toBe(150)
    expect(canonChapterCount("OBA")).toBe(1)
    expect(canonChapterCount("REV")).toBe(22)
  })

  it("returns null for anything the canon does not have", () => {
    expect(canonChapterCount("TOB")).toBeNull()
    expect(canonChapterCount("")).toBeNull()
    expect(canonChapterCount(null)).toBeNull()
  })
})
