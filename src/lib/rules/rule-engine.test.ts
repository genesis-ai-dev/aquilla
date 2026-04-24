import { describe, it, expect } from "vitest"
import { checkRules } from "./rule-engine"
import type { TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    original: "test", translated: "", fileId: "test-file", context: "", group: "", type: "text",
    originalHtml: undefined, status: "empty", validationStatus: "none", activeValidators: [],
    validationHistory: [],
    history: [], threads: [],
    ...overrides,
  }
}

function makeRule(overrides: Partial<TranslationRule> & { id: string; check: TranslationRule["check"] }): TranslationRule {
  return {
    name: "Test Rule", description: "", severity: "major", source: "user",
    scope: "project", enabled: true, createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("checkRules", () => {
  it("returns empty map for no rules", () => {
    const cells = new Map([["f1", [makeCell({ id: "c1", translated: "hello", status: "validated" })]]])
    const result = checkRules(cells, [])
    expect(result.size).toBe(0)
  })

  it("returns empty map for no cells", () => {
    const rules = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" } })]
    const result = checkRules(new Map(), rules)
    expect(result.size).toBe(0)
  })

  it("detects target-forbids infraction", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "this is bad text", status: "validated", original: "source" }),
    ]]])
    const rules = [makeRule({ id: "r1", name: "No bad", check: { type: "target-forbids", targetPattern: "bad" } })]
    const result = checkRules(cells, rules)
    expect(result.get("c1")).toHaveLength(1)
    expect(result.get("c1")![0].ruleId).toBe("r1")
  })

  it("passes target-forbids when pattern not found", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "this is good text", status: "validated", original: "source" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" } })]
    const result = checkRules(cells, rules)
    expect(result.has("c1")).toBe(false)
  })

  it("detects source-requires-target infraction", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "Chapter 5 is here", translated: "Chapitre est ici", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", name: "Preserve numbers", check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" } })]
    const result = checkRules(cells, rules)
    expect(result.get("c1")).toHaveLength(1) // source has "5" but target has no number
  })

  it("passes source-requires-target when both match", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "Chapter 5", translated: "Chapitre 5", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" } })]
    const result = checkRules(cells, rules)
    expect(result.has("c1")).toBe(false)
  })

  it("skips source-requires-target when source doesn't match", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "No numbers here", translated: "Pas de nombres", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" } })]
    const result = checkRules(cells, rules)
    expect(result.has("c1")).toBe(false) // source doesn't match, rule doesn't apply
  })

  it("detects source-target-match infraction", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "Visit https://example.com today", translated: "Visitez aujourd'hui", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", name: "Preserve URLs", check: { type: "source-target-match", pattern: "https?://\\S+" } })]
    const result = checkRules(cells, rules)
    expect(result.get("c1")).toHaveLength(1) // URL in source but not target
  })

  it("passes source-target-match when both contain pattern", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "Visit https://example.com", translated: "Visitez https://example.com", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "source-target-match", pattern: "https?://\\S+" } })]
    const result = checkRules(cells, rules)
    expect(result.has("c1")).toBe(false)
  })

  it("skips disabled rules", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "bad text", status: "validated", original: "source" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" }, enabled: false })]
    const result = checkRules(cells, rules)
    expect(result.size).toBe(0)
  })

  it("skips empty cells", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1" }), // empty
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" } })]
    const result = checkRules(cells, rules)
    expect(result.size).toBe(0)
  })

  it("accumulates multiple infractions per cell", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "Test 42", translated: "bad text no number", status: "validated" }),
    ]]])
    const rules = [
      makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" } }),
      makeRule({ id: "r2", check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" } }),
    ]
    const result = checkRules(cells, rules)
    expect(result.get("c1")).toHaveLength(2)
  })

  it("handles invalid regex gracefully", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "text", status: "validated", original: "source" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "[invalid" } })]
    const result = checkRules(cells, rules)
    // Should not throw, just skip the rule
    expect(result.size).toBe(0)
  })
})

describe("infraction spans", () => {
  it("target-forbids records a span on target for each match", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "this is bad and also bad twice", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" } })]
    const result = checkRules(cells, rules)
    const inf = result.get("c1")![0]
    expect(inf.spans).toHaveLength(2)
    expect(inf.spans[0]).toEqual({ side: "target", start: 8, end: 11, matchedText: "bad" })
    expect(inf.spans[1]).toEqual({ side: "target", start: 21, end: 24, matchedText: "bad" })
  })

  it("source-target-match records source spans when source has trigger but target doesn't", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "Chapter 5 and verse 7", translated: "Chapitre et verset", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "source-target-match", pattern: "\\d+" } })]
    const result = checkRules(cells, rules)
    const inf = result.get("c1")![0]
    expect(inf.spans).toHaveLength(2)
    expect(inf.spans[0].side).toBe("source")
    expect(inf.spans[0].matchedText).toBe("5")
    expect(inf.spans[1].matchedText).toBe("7")
  })
})
