import { describe, it, expect } from "vitest"
import { extractPlaintextStrings } from "./plaintext"

describe("extractPlaintextStrings", () => {
  it("splits on double newlines into paragraphs", () => {
    const text = "First paragraph.\n\nSecond paragraph."
    const result = extractPlaintextStrings(text)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("First paragraph.")
    expect(result[0].context).toBe("Paragraph 1")
    expect(result[0].type).toBe("text")
    expect(result[1].original).toBe("Second paragraph.")
    expect(result[1].context).toBe("Paragraph 2")
  })

  it("sets translated equal to original", () => {
    const result = extractPlaintextStrings("Hello")
    expect(result[0].translated).toBe("")
  })

  it("assigns unique IDs and group IDs", () => {
    const result = extractPlaintextStrings("A\n\nB")
    expect(result[0].id).toBeTruthy()
    expect(result[1].id).toBeTruthy()
    expect(result[0].id).not.toBe(result[1].id)
  })

  it("segments long paragraphs", () => {
    const longParagraph = Array(20).fill("This is a sentence.").join(" ")
    const result = extractPlaintextStrings(longParagraph)
    expect(result.length).toBeGreaterThan(1)
    const groups = new Set(result.map((r) => r.group))
    expect(groups.size).toBe(1)
  })

  it("keeps every comma when it segments a long paragraph (AQU-1469)", () => {
    const para =
      "And then finally, after a long week of travel through the hills and the valleys and the towns, " +
      "we came home to the house by the river where the old trees grow, and the lamps were lit, " +
      "and the table was set for all of us who had come so far"
    expect(para.length).toBeGreaterThan(200)
    const result = extractPlaintextStrings(para)
    expect(result.length).toBeGreaterThan(1)
    expect(result.map((r) => r.original).join(" ")).toBe(para)
  })

  it("handles empty input", () => {
    expect(extractPlaintextStrings("")).toHaveLength(0)
    expect(extractPlaintextStrings("   ")).toHaveLength(0)
  })
})
