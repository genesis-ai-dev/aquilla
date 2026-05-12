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
})
