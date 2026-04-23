import { describe, it, expect } from "vitest"
import { applyRegexFix, applyLiteralFix } from "./autofix"
import { parseBatchResponse, parsePerCellResponse } from "./autofix"

describe("applyRegexFix", () => {
  it("replaces all matches with global flag", () => {
    const fix = { kind: "regex-replace" as const, pattern: "\\bfoo\\b", replacement: "bar", flags: "gi" }
    expect(applyRegexFix(fix, "foo and Foo and foobar")).toBe("bar and bar and foobar")
  })

  it("replaces first only without global flag", () => {
    const fix = { kind: "regex-replace" as const, pattern: "foo", replacement: "bar", flags: "i" }
    expect(applyRegexFix(fix, "foo and foo")).toBe("bar and foo")
  })

  it("supports capture-group backreferences", () => {
    const fix = { kind: "regex-replace" as const, pattern: "(\\d+) dollars", replacement: "$$$1", flags: "g" }
    expect(applyRegexFix(fix, "5 dollars and 10 dollars")).toBe("$5 and $10")
  })

  it("returns original text when pattern does not match", () => {
    const fix = { kind: "regex-replace" as const, pattern: "xyz", replacement: "q", flags: "g" }
    expect(applyRegexFix(fix, "abc")).toBe("abc")
  })

  it("throws for invalid regex", () => {
    const fix = { kind: "regex-replace" as const, pattern: "(", replacement: "x", flags: "g" }
    expect(() => applyRegexFix(fix, "anything")).toThrow()
  })
})

describe("applyLiteralFix", () => {
  it("replaces all occurrences literally", () => {
    expect(applyLiteralFix("don't", "do not", "I don't but you don't either")).toBe("I do not but you do not either")
  })

  it("preserves surrounding formatting (markdown-like)", () => {
    expect(applyLiteralFix("foo", "bar", "**foo** and _foo_")).toBe("**bar** and _bar_")
  })

  it("returns original when find not present", () => {
    expect(applyLiteralFix("x", "y", "abc")).toBe("abc")
  })

  it("is safe with regex metacharacters in find", () => {
    expect(applyLiteralFix("a.b", "ab", "a.b and a.b and axb")).toBe("ab and ab and axb")
  })
})

describe("parseBatchResponse", () => {
  it("parses a regex-replace response", () => {
    const raw = `{"kind":"regex-replace","pattern":"foo","replacement":"bar","flags":"gi","rationale":"r"}`
    expect(parseBatchResponse(raw)).toEqual({
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "gi", rationale: "r",
    })
  })

  it("parses a none response", () => {
    const raw = `{"kind":"none","reason":"too semantic"}`
    expect(parseBatchResponse(raw)).toEqual({ kind: "none", reason: "too semantic" })
  })

  it("strips markdown code fences", () => {
    const raw = "```json\n{\"kind\":\"none\",\"reason\":\"r\"}\n```"
    expect(parseBatchResponse(raw)).toEqual({ kind: "none", reason: "r" })
  })

  it("returns null for invalid JSON", () => {
    expect(parseBatchResponse("not json")).toBeNull()
  })

  it("returns null for unknown kind", () => {
    expect(parseBatchResponse(`{"kind":"ignore"}`)).toBeNull()
  })

  it("returns null when regex-replace is missing required fields", () => {
    expect(parseBatchResponse(`{"kind":"regex-replace","pattern":"p"}`)).toBeNull()
  })
})

describe("parsePerCellResponse", () => {
  it("parses valid fixes", () => {
    const raw = `{"kind":"per-cell","fixes":[{"cellId":"c1","find":"a","replace":"b","rationale":"r"}]}`
    const parsed = parsePerCellResponse(raw)
    expect(parsed?.kind).toBe("per-cell")
    expect(parsed?.kind === "per-cell" && parsed.fixes).toHaveLength(1)
  })

  it("parses none", () => {
    const raw = `{"kind":"none","reason":"r"}`
    expect(parsePerCellResponse(raw)).toEqual({ kind: "none", reason: "r" })
  })

  it("filters malformed fix entries", () => {
    const raw = JSON.stringify({
      kind: "per-cell",
      fixes: [
        { cellId: "c1", find: "a", replace: "b" },
        { cellId: "c2", find: "x" }, // missing replace
        { find: "a", replace: "b" },  // missing cellId
        "bad",
      ],
    })
    const parsed = parsePerCellResponse(raw)
    expect(parsed?.kind === "per-cell" && parsed.fixes.map((f) => f.cellId)).toEqual(["c1"])
  })

  it("returns null for invalid JSON", () => {
    expect(parsePerCellResponse("garbage")).toBeNull()
  })
})
