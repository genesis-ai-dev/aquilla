import { describe, it, expect } from "vitest"
import { tokenizeText, stripTags } from "./tokenizer"

describe("stripTags", () => {
  it("removes HTML tags but keeps text", () => {
    expect(stripTags("Hello <b>brave</b> world")).toBe("Hello  brave  world")
  })
  it("handles empty input", () => {
    expect(stripTags("")).toBe("")
  })
})

describe("tokenizeText", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenizeText("Hello World")).toEqual(["hello", "world"])
  })
  it("strips HTML tags", () => {
    expect(tokenizeText("This is <b>bold</b> text")).toEqual(["this", "is", "bold", "text"])
  })
  it("strips punctuation", () => {
    expect(tokenizeText("Hello, world! How's it?")).toEqual(["hello", "world", "how", "s", "it"])
  })
  it("handles empty input", () => {
    expect(tokenizeText("")).toEqual([])
    expect(tokenizeText("   ")).toEqual([])
  })
  it("filters empty strings", () => {
    expect(tokenizeText("  multiple   spaces  ")).toEqual(["multiple", "spaces"])
  })

  // Unicode-aware tokenization: \w-based stripping used to delete every
  // accented or non-Latin letter, so most projects tokenized to nothing.
  it("keeps accented Latin letters intact", () => {
    expect(tokenizeText("Más allá, ¡qué día!")).toEqual(["más", "allá", "qué", "día"])
  })
  it("tokenizes Greek text", () => {
    expect(tokenizeText("Ἐν ἀρχῇ ἦν ὁ λόγος")).toEqual(["ἐν", "ἀρχῇ", "ἦν", "ὁ", "λόγος"])
  })
  it("tokenizes Hebrew text with punctuation", () => {
    expect(tokenizeText("בְּרֵאשִׁית, בָּרָא")).toEqual(["בְּרֵאשִׁית", "בָּרָא"])
  })
  it("tokenizes Cyrillic text", () => {
    expect(tokenizeText("В начале было Слово")).toEqual(["в", "начале", "было", "слово"])
  })
})
