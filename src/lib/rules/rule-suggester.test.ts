import { describe, it, expect } from "vitest"
import { parseRuleSuggestions } from "./rule-suggester"

describe("parseRuleSuggestions", () => {
  it("parses a valid JSON array", () => {
    const raw = `[{"name":"Preserve numbers","description":"Numbers must match","severity":"major","check":{"type":"source-target-match","pattern":"\\\\d+"}}]`
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Preserve numbers")
    expect(result[0].severity).toBe("major")
    expect(result[0].check.type).toBe("source-target-match")
  })

  it("strips markdown code fences", () => {
    const raw = "```json\n[{\"name\":\"Test\",\"description\":\"d\",\"severity\":\"minor\",\"check\":{\"type\":\"target-forbids\",\"targetPattern\":\"bad\"}}]\n```"
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Test")
  })

  it("handles surrounding prose", () => {
    const raw = `Here are the rules:\n\n[{"name":"R","description":"d","severity":"minor","check":{"type":"target-forbids","targetPattern":"x"}}]\n\nThat's all.`
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseRuleSuggestions("not json")).toEqual([])
    expect(parseRuleSuggestions("[unclosed")).toEqual([])
  })

  it("returns empty array for missing array", () => {
    expect(parseRuleSuggestions("{}")).toEqual([])
  })

  it("filters out invalid suggestions", () => {
    const raw = JSON.stringify([
      { name: "Valid", description: "d", severity: "major", check: { type: "target-forbids", targetPattern: "x" } },
      { name: "", description: "", severity: "major", check: { type: "target-forbids", targetPattern: "x" } }, // empty name
      { name: "Bad severity", description: "", severity: "critical", check: { type: "target-forbids", targetPattern: "x" } },
      { name: "Missing check", description: "", severity: "major" },
      { name: "Wrong check type", description: "", severity: "major", check: { type: "unknown" } },
    ])
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Valid")
  })

  it("validates source-requires-target needs both patterns", () => {
    const raw = JSON.stringify([
      { name: "Complete", description: "", severity: "major", check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" } },
      { name: "Missing target", description: "", severity: "major", check: { type: "source-requires-target", sourcePattern: "\\d+" } },
    ])
    const result = parseRuleSuggestions(raw)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Complete")
  })
})
