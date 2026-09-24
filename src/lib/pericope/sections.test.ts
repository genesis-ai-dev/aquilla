import { describe, expect, it } from "vitest"
import raw from "./bible-section-counts.txt?raw"
import { OSIS_BOOK_COUNT, usfmFromOsis } from "./osis"
import {
  boundaryScore,
  compareAddresses,
  formatRef,
  indexSections,
  parseRef,
  parseSectionCounts,
} from "./sections"

const FIXTURE = [
  "#Start verse of section\tEnd verse of section\tVerse after end verse\tNumber of translations",
  "Gen.1.1\tGen.1.31\tGen.2.1\t4",
  "Gen.1.1\tGen.2.3\tGen.2.4\t14",
  "Gen.2.4\tGen.2.25\tGen.3.1\t15",
  "1Sam.3.1\t1Sam.3.21\t1Sam.4.1\t12",
  "",
].join("\n")

describe("parseSectionCounts", () => {
  it("maps OSIS refs onto USFM book codes and keeps the translation count", () => {
    const sections = parseSectionCounts(FIXTURE)
    expect(sections).toEqual([
      { book: "GEN", start: { chapter: 1, verse: 1 }, end: { chapter: 1, verse: 31 }, translations: 4 },
      { book: "GEN", start: { chapter: 1, verse: 1 }, end: { chapter: 2, verse: 3 }, translations: 14 },
      { book: "GEN", start: { chapter: 2, verse: 4 }, end: { chapter: 2, verse: 25 }, translations: 15 },
      { book: "1SA", start: { chapter: 3, verse: 1 }, end: { chapter: 3, verse: 21 }, translations: 12 },
    ])
  })

  it("skips rows it cannot read rather than throwing", () => {
    const sections = parseSectionCounts([
      "#header",
      "Gen.1.1\tGen.1.31\tGen.2.1\t4",
      "Tob.1.1\tTob.1.9\tTob.1.10\t3", // deuterocanon — not in the OSIS table
      "Gen.5.1\tGen.5.32", // truncated row
      "Gen.6.1\tGen.6.22\tGen.7.1\tnot-a-number",
    ].join("\n"))
    expect(sections).toHaveLength(1)
    expect(sections[0]?.book).toBe("GEN")
  })
})

describe("the vendored dataset", () => {
  const sections = parseSectionCounts(raw)

  it("still parses to the documented size and shape", () => {
    // 12,649 data rows upstream on 2026-09-24; a refresh that silently halves
    // the file (or changes the column order) fails here instead of quietly
    // producing no suggestions.
    expect(sections.length).toBeGreaterThan(12_000)
    expect(sections.every((section) => section.translations >= 1 && section.translations <= 20)).toBe(true)
  })

  it("covers every book the OSIS table maps", () => {
    const books = new Set(sections.map((section) => section.book))
    expect(books.size).toBe(OSIS_BOOK_COUNT)
    expect(books.has("GEN")).toBe(true)
    expect(books.has("REV")).toBe(true)
  })

  it("keeps every section inside one book", () => {
    expect(sections.every((section) => compareAddresses(section.start, section.end) <= 0)).toBe(true)
  })
})

describe("indexSections", () => {
  const index = indexSections(parseSectionCounts(FIXTURE))

  it("groups by book and orders by start, strongest first", () => {
    expect([...index.keys()].sort()).toEqual(["1SA", "GEN"])
    expect(index.get("GEN")?.map((section) => section.translations)).toEqual([14, 4, 15])
  })
})

describe("boundaryScore", () => {
  const index = indexSections(parseSectionCounts(FIXTURE))

  it("is the strongest section starting at that verse", () => {
    expect(boundaryScore(index, "GEN", { chapter: 1, verse: 1 })).toBe(14)
    expect(boundaryScore(index, "GEN", { chapter: 2, verse: 4 })).toBe(15)
  })

  it("is zero where no surveyed translation breaks, and for unknown books", () => {
    expect(boundaryScore(index, "GEN", { chapter: 1, verse: 5 })).toBe(0)
    expect(boundaryScore(index, "REV", { chapter: 1, verse: 1 })).toBe(0)
  })
})

describe("ref helpers", () => {
  it("formats canonical refs the way cells carry them", () => {
    expect(formatRef("GEN", { chapter: 2, verse: 4 })).toBe("GEN 2:4")
  })

  it("parses canonical refs, tolerating sub-verse suffixes", () => {
    expect(parseRef("GEN 2:4")).toEqual({ book: "GEN", address: { chapter: 2, verse: 4 } })
    expect(parseRef("1SA 3:1a")).toEqual({ book: "1SA", address: { chapter: 3, verse: 1 } })
    expect(parseRef("gen 2:4")).toEqual({ book: "GEN", address: { chapter: 2, verse: 4 } })
    expect(parseRef("not a ref")).toBeUndefined()
  })

  it("maps OSIS abbreviations that differ from the USFM code", () => {
    expect(usfmFromOsis("Phlm")).toBe("PHM")
    expect(usfmFromOsis("Song")).toBe("SNG")
    expect(usfmFromOsis("Tob")).toBeUndefined()
  })
})
