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

  // AQU-1469: the comma and dash cuts used to swallow their punctuation.
  const clause = "and then the long clause keeps going with more words in it"
  it.each([
    ["comma", ", "],
    ["em dash", " — "],
    ["spaced hyphen", " - "],
  ])("keeps the %s on the segment before a cut", (_name, sep) => {
    const text = [clause, clause, clause, clause, clause].join(sep)
    expect(text.length).toBeGreaterThan(250)
    const result = splitIntoSegments(text)
    expect(result.length).toBeGreaterThan(1)
    expect(result[0].text.endsWith(sep.trimEnd())).toBe(true)
    expect(mergeSegments(result)).toBe(text)
  })

  it("keeps an unspaced em dash inside a segment and at a cut", () => {
    const text = Array(5).fill(clause).join("—")
    const result = splitIntoSegments(text)
    expect(result.length).toBeGreaterThan(1)
    expect(result[0].text).toContain(clause + "—" + clause)
    expect(result[0].text.endsWith("—")).toBe(true)
    expect(result.map((s) => s.text).join("")).toBe(text)
  })

  it("rejoins any long paragraph to the original text", () => {
    const words = ["And", "then", "finally,", "we", "came", "home;", "it", "rained.", "Why?", "Well —", "who", "knows", "-", "maybe", "luck:", "no", "one", "said,"]
    for (let seed = 1; seed <= 50; seed++) {
      let n = seed
      const picked: string[] = []
      for (let i = 0; i < 80; i++) {
        n = (n * 1103515245 + 12345) % 2147483648
        picked.push(words[n % words.length])
      }
      const text = picked.join(" ")
      const result = splitIntoSegments(text)
      expect(result.every((s) => s.text.length <= 200)).toBe(true)
      expect(mergeSegments(result)).toBe(text)
    }
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
