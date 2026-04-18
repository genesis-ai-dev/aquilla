import { describe, it, expect } from "vitest"
import { groupRulesByType, type StandardGroup } from "./group-rules"
import type { TranslationRule } from "@/lib/parsers/types"

function makeRule(overrides: Partial<TranslationRule> & { id: string; check: TranslationRule["check"] }): TranslationRule {
  return {
    name: "Test Rule",
    description: "",
    severity: "major",
    source: "user",
    scope: "project",
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("groupRulesByType", () => {
  it("returns empty groups when no rules are provided", () => {
    const result: StandardGroup = groupRulesByType([])
    expect(result.mustPreserve).toEqual([])
    expect(result.mustInclude).toEqual([])
    expect(result.mustNotContain).toEqual([])
  })

  it("filters out disabled rules", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", enabled: false, check: { type: "target-forbids", targetPattern: "foo" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustNotContain).toEqual([])
  })

  it("groups source-target-match as mustPreserve", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", name: "Numbers", check: { type: "source-target-match", pattern: "\\d+" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustPreserve).toHaveLength(1)
    expect(result.mustPreserve[0].name).toBe("Numbers")
  })

  it("groups source-requires-target as mustInclude", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", check: { type: "source-requires-target", sourcePattern: "yo", targetPattern: "ya" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustInclude).toHaveLength(1)
  })

  it("groups target-forbids as mustNotContain", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "thee|thou" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustNotContain).toHaveLength(1)
  })

  it("preserves rule order within each group", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "a", name: "A", check: { type: "target-forbids", targetPattern: "x" } }),
      makeRule({ id: "b", name: "B", check: { type: "target-forbids", targetPattern: "y" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustNotContain.map((r) => r.name)).toEqual(["A", "B"])
  })
})
