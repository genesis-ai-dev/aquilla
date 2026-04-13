import { describe, it, expect } from "vitest"
import { splitIntoSegments, mergeSegments } from "./text-splitter"

describe("splitIntoSegments", () => {
  it("returns single segment for short text", () => {
    const result = splitIntoSegments("Hello world")
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("Hello world")
    expect(result[0].group).toBeTruthy()
  })

  it("all segments share the same group ID", () => {
    const longText = "A".repeat(100) + ". " + "B".repeat(100) + ". " + "C".repeat(100)
    const result = splitIntoSegments(longText, 150)
    expect(result.length).toBeGreaterThan(1)
    const groups = new Set(result.map((s) => s.group))
    expect(groups.size).toBe(1)
  })

  it("splits on sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence."
    const result = splitIntoSegments(text, 40)
    expect(result.length).toBeGreaterThan(1)
    expect(result[0].text).toContain("First sentence.")
  })

  it("splits on paragraph boundaries first", () => {
    const text = "Paragraph one is here.\n\nParagraph two is here."
    const result = splitIntoSegments(text, 30)
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe("Paragraph one is here.")
    expect(result[1].text).toBe("Paragraph two is here.")
  })

  it("handles text shorter than maxLength", () => {
    const result = splitIntoSegments("Short", 200)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("Short")
  })
})

describe("mergeSegments", () => {
  it("rejoins segments into original text", () => {
    const segments = [
      { text: "Hello world.", group: "g1" },
      { text: "Goodbye world.", group: "g1" },
    ]
    expect(mergeSegments(segments)).toBe("Hello world. Goodbye world.")
  })
})
