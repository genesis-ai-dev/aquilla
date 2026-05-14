import { describe, it, expect } from "vitest"
import { getBookName, isKnownBookCode } from "./bible-book-names"

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
