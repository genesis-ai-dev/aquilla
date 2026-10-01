import { describe, expect, it } from "vitest"
import {
  SECTION_COUNT_TRANSLATIONS,
  __resetSectionBoundaries,
  loadSectionBoundaries,
  parseSectionBoundaries,
} from "./section-boundaries"

describe("compiled CC0 section-counts dataset", () => {
  it("indexes a chapter's section starts with their translation counts", () => {
    const index = parseSectionBoundaries([
      "# provenance header, skipped",
      "",
      "LUK.5 1:19 12:19 17:19 27:19 29:1 33:18 36:2",
    ].join("\n"))

    expect(index.strengthAt("LUK", 5, 1)).toBe(19)
    expect(index.strengthAt("LUK", 5, 33)).toBe(18)
    // A verse inside a section, not starting one.
    expect(index.strengthAt("LUK", 5, 5)).toBeUndefined()
    expect(index.covers("LUK", 5)).toBe(true)
    expect(index.chapterCount).toBe(1)
  })

  it("distinguishes a chapter it is silent about from one with no boundary here", () => {
    const index = parseSectionBoundaries("LUK.5 1:19")
    // Silent: the dataset has no opinion, so a caller must ask the model.
    expect(index.covers("TOB", 3)).toBe(false)
    expect(index.covers("LUK", 6)).toBe(false)
    // Covered, but this verse starts nothing.
    expect(index.covers("LUK", 5)).toBe(true)
    expect(index.strengthAt("LUK", 5, 2)).toBeUndefined()
  })

  it("lists a chapter's starts in verse order", () => {
    const index = parseSectionBoundaries("MRK.2 13:18 1:19 23:17")
    expect(index.startsIn("MRK", 2)).toEqual([
      { verse: 1, translations: 19 },
      { verse: 13, translations: 18 },
      { verse: 23, translations: 17 },
    ])
    expect(index.startsIn("MRK", 9)).toEqual([])
  })

  it("normalizes book case so an importer's casing cannot miss the index", () => {
    const index = parseSectionBoundaries("luk.5 1:19")
    expect(index.strengthAt("LUK", 5, 1)).toBe(19)
    expect(index.strengthAt("Luk", 5, 1)).toBe(19)
  })

  it("skips a malformed line instead of throwing", () => {
    // A corrupted data file must read as "silent about that chapter", never
    // break the import that asked for passages.
    const index = parseSectionBoundaries([
      "not-a-chapter-line",
      "LUK.5",
      "JHN.1 x:y 1:20",
      "MRK.1 1:19",
    ].join("\n"))
    expect(index.covers("LUK", 5)).toBe(false)
    expect(index.strengthAt("JHN", 1, 1)).toBe(20)
    expect(index.strengthAt("MRK", 1, 1)).toBe(19)
  })

  describe("the committed dataset", () => {
    it("loads, covers the Protestant canon, and agrees with upstream on Luke 5", async () => {
      __resetSectionBoundaries()
      const index = await loadSectionBoundaries()

      // 1189 chapters is the whole 66-book canon; a partial compile would show
      // up here rather than as quietly missing passages in one book.
      expect(index.chapterCount).toBe(1189)

      // Upstream: 19 of 20 translations start a section at each of these, which
      // is the pericope structure of Luke 5 as published Bibles print it.
      expect(index.startsIn("LUK", 5).map((start) => start.verse))
        .toEqual([1, 12, 17, 27, 29, 33, 36])
      expect(index.strengthAt("LUK", 5, 12)).toBe(19)

      // Genesis 1:1 is the one boundary every translation agrees on.
      expect(index.strengthAt("GEN", 1, 1)).toBe(SECTION_COUNT_TRANSLATIONS)

      // Book codes are USFM, converted at compile time — upstream's own
      // abbreviations are not a runtime vocabulary and must not resolve.
      expect(index.covers("EXO", 20)).toBe(true)
      expect(index.covers("PSA", 119)).toBe(true)
      expect(index.covers("1JN", 1)).toBe(true)
      expect(index.covers("Exod", 20)).toBe(false)

      // Deuterocanon is outside the panel — silent, so the model fills in.
      expect(index.covers("TOB", 1)).toBe(false)
    })

    it("never reports more starts at a verse than there are translations", async () => {
      __resetSectionBoundaries()
      const index = await loadSectionBoundaries()
      // The compile SUMS upstream rows sharing a start verse. If a translation
      // could contribute twice to one verse that sum would exceed the panel
      // size, and every strength would be a meaningless ratio.
      for (const book of ["GEN", "PSA", "ISA", "MAT", "LUK", "ROM", "REV"]) {
        for (let chapter = 1; chapter <= 40; chapter += 1) {
          for (const start of index.startsIn(book, chapter)) {
            expect(start.translations).toBeGreaterThan(0)
            expect(start.translations).toBeLessThanOrEqual(SECTION_COUNT_TRANSLATIONS)
          }
        }
      }
    })
  })
})
