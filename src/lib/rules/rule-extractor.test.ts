import { describe, it, expect } from "vitest"
import {
  checkInputSize,
  parseCandidates,
  parseStructuredRule,
  MAX_INPUT_BYTES,
} from "./rule-extractor"

describe("checkInputSize", () => {
  it("accepts text under 200 KB", () => {
    const text = "a".repeat(100 * 1024)
    expect(checkInputSize(text).ok).toBe(true)
  })

  it("rejects text over 200 KB", () => {
    const text = "a".repeat(MAX_INPUT_BYTES + 1)
    const result = checkInputSize(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/too large/i)
    }
  })

  it("accepts text exactly at the limit", () => {
    const text = "a".repeat(MAX_INPUT_BYTES)
    expect(checkInputSize(text).ok).toBe(true)
  })
})

describe("parseCandidates", () => {
  it("parses a simple JSON array of strings", () => {
    const raw = `["Numbers must be preserved", "URLs must not be translated"]`
    expect(parseCandidates(raw)).toEqual([
      "Numbers must be preserved",
      "URLs must not be translated",
    ])
  })

  it("strips markdown code fences", () => {
    const raw = "```json\n[\"Rule A\", \"Rule B\"]\n```"
    expect(parseCandidates(raw)).toEqual(["Rule A", "Rule B"])
  })

  it("returns empty array for null/invalid JSON", () => {
    expect(parseCandidates("null")).toEqual([])
    expect(parseCandidates("not json")).toEqual([])
    expect(parseCandidates("{}")).toEqual([])
  })

  it("filters out non-string entries", () => {
    const raw = `["Valid rule", 42, null, "Another rule"]`
    expect(parseCandidates(raw)).toEqual(["Valid rule", "Another rule"])
  })

  it("returns empty array for empty array", () => {
    expect(parseCandidates("[]")).toEqual([])
  })
})

describe("parseStructuredRule", () => {
  it("parses a valid source-target-match rule", () => {
    const raw = JSON.stringify({
      name: "Number preservation",
      description: "All numbers must appear verbatim in the target",
      severity: "major",
      check: { type: "source-target-match", pattern: "\\d+" },
    })
    const result = parseStructuredRule(raw)
    expect(result).not.toBeNull()
    expect(result?.name).toBe("Number preservation")
    expect(result?.check.type).toBe("source-target-match")
  })

  it("parses a valid target-forbids rule", () => {
    const raw = JSON.stringify({
      name: "No ellipsis",
      description: "Targets must not end with ellipsis",
      severity: "minor",
      check: { type: "target-forbids", targetPattern: "\\.{3}$" },
    })
    const result = parseStructuredRule(raw)
    expect(result).not.toBeNull()
    expect(result?.check.type).toBe("target-forbids")
  })

  it("parses a valid source-requires-target rule", () => {
    const raw = JSON.stringify({
      name: "Church term",
      description: "The word church must be translated as ekklesia",
      severity: "major",
      check: {
        type: "source-requires-target",
        sourcePattern: "church",
        targetPattern: "ekklesia",
      },
    })
    const result = parseStructuredRule(raw)
    expect(result).not.toBeNull()
    expect(result?.check.type).toBe("source-requires-target")
  })

  it("returns null for 'null' response", () => {
    expect(parseStructuredRule("null")).toBeNull()
  })

  it("returns null for missing required fields", () => {
    const raw = JSON.stringify({ name: "Incomplete", severity: "major" })
    expect(parseStructuredRule(raw)).toBeNull()
  })

  it("returns null for invalid check type", () => {
    const raw = JSON.stringify({
      name: "Bad",
      description: "x",
      severity: "major",
      check: { type: "unknown-type" },
    })
    expect(parseStructuredRule(raw)).toBeNull()
  })

  it("strips markdown code fences before parsing", () => {
    const inner = JSON.stringify({
      name: "Test",
      description: "desc",
      severity: "minor",
      check: { type: "target-forbids", targetPattern: "foo" },
    })
    const wrapped = "```json\n" + inner + "\n```"
    expect(parseStructuredRule(wrapped)).not.toBeNull()
  })
})
