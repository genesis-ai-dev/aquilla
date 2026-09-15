import { describe, it, expect } from "vitest"
import { getBookName, isKnownBookCode, compareByCanonicalBookOrder, bookCodeFromFileName } from "./bible-book-names"

describe("getBookName", () => {
  it("returns English name for OT book codes", () => {
    expect(getBookName("GEN")).toBe("Genesis")
    expect(getBookName("EXO")).toBe("Exodus")
    expect(getBookName("MAL")).toBe("Malachi")
    expect(getBookName("1SA")).toBe("1 Samuel")
    expect(getBookName("2CH")).toBe("2 Chronicles")
  })
  it("returns English name for NT book codes", () => {
    expect(getBookName("MAT")).toBe("Matthew")
    expect(getBookName("JHN")).toBe("John")
    expect(getBookName("1JN")).toBe("1 John")
    expect(getBookName("REV")).toBe("Revelation")
  })
  it("is case-insensitive", () => {
    expect(getBookName("gen")).toBe("Genesis")
    expect(getBookName("Rev")).toBe("Revelation")
  })
  it("returns undefined for unknown codes", () => {
    expect(getBookName("xyz")).toBeUndefined()
    expect(getBookName("")).toBeUndefined()
  })
})

describe("isKnownBookCode", () => {
  it("returns true for 66 canonical books", () => {
    expect(isKnownBookCode("GEN")).toBe(true)
    expect(isKnownBookCode("REV")).toBe(true)
  })
  it("returns false for unknown", () => {
    expect(isKnownBookCode("ZZZ")).toBe(false)
  })
})

describe("compareByCanonicalBookOrder (AQU-582)", () => {
  it("sorts book names into canonical reading order, not alphabetic", () => {
    const names = ["Numbers", "Genesis", "Leviticus", "Exodus"]
    expect([...names].sort(compareByCanonicalBookOrder))
      .toEqual(["Genesis", "Exodus", "Leviticus", "Numbers"])
  })

  it("orders OT before NT", () => {
    expect([...["Revelation", "Genesis", "Matthew"]].sort(compareByCanonicalBookOrder))
      .toEqual(["Genesis", "Matthew", "Revelation"])
  })

  it("understands raw USFM codes too", () => {
    expect([...["MRK", "MAT", "GEN"]].sort(compareByCanonicalBookOrder))
      .toEqual(["GEN", "MAT", "MRK"])
  })

  it("sorts unknown (non-book) names after all known books, alphabetically", () => {
    expect([...["Zeta Notes", "John", "Alpha Notes", "Mark"]].sort(compareByCanonicalBookOrder))
      .toEqual(["Mark", "John", "Alpha Notes", "Zeta Notes"])
  })
})

describe("bookCodeFromFileName (AQU-1084)", () => {
  it("reads a bare code, with or without an extension, in any case", () => {
    expect(bookCodeFromFileName("1CH")).toBe("1CH")
    expect(bookCodeFromFileName("gen.usfm")).toBe("GEN")
    expect(bookCodeFromFileName("Mat")).toBe("MAT")
  })

  it("prefers the end of the stem so numbered prefixes work", () => {
    expect(bookCodeFromFileName("40-MAT.usfm")).toBe("MAT")
  })

  it("falls back to the front of the stem for friendly names", () => {
    expect(bookCodeFromFileName("Genesis")).toBe("GEN")
    expect(bookCodeFromFileName("Revelation.usfm")).toBe("REV")
  })

  it("returns undefined when neither end of the stem is a known code", () => {
    expect(bookCodeFromFileName("readme")).toBeUndefined()
    expect(bookCodeFromFileName("World English Bible (eng-engwebp)")).toBeUndefined()
    expect(bookCodeFromFileName("")).toBeUndefined()
  })
})
