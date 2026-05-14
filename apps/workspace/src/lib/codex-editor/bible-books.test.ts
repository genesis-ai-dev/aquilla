// src/lib/codex-editor/bible-books.test.ts
import { describe, it, expect } from "vitest"
import { getTestament } from "./bible-books"

describe("getTestament", () => {
  it("returns OT for Old Testament books", () => {
    expect(getTestament("GEN")).toBe("OT")
    expect(getTestament("MAL")).toBe("OT")
  })
  it("returns NT for New Testament books", () => {
    expect(getTestament("MAT")).toBe("NT")
    expect(getTestament("REV")).toBe("NT")
  })
  it("is case-insensitive on the abbreviation", () => {
    expect(getTestament("gen")).toBe("OT")
    expect(getTestament("Mat")).toBe("NT")
  })
  it("returns undefined for unknown abbreviations", () => {
    expect(getTestament("xyz")).toBeUndefined()
    expect(getTestament("")).toBeUndefined()
  })
})
