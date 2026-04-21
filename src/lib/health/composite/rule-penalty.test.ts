import { describe, it, expect } from "vitest"
import { rulePenalty } from "./rule-penalty"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"

function rule(id: string, severity: "major" | "minor"): TranslationRule {
  return {
    id, name: id, description: "", severity,
    source: "user", scope: "project", check: { type: "target-forbids", targetPattern: "" },
    enabled: true, createdAt: "",
  }
}
function inf(ruleId: string): RuleInfraction {
  return { ruleId, cellId: "c", fileId: "f", message: "" }
}

describe("rulePenalty", () => {
  it("returns 0 when no infractions", () => {
    expect(rulePenalty([], [], { major: 15, minor: 5 }, 40)).toBe(0)
  })
  it("sums minor penalties", () => {
    const rules = [rule("r1", "minor"), rule("r2", "minor")]
    expect(rulePenalty([inf("r1"), inf("r2")], rules, { major: 15, minor: 5 }, 40)).toBe(10)
  })
  it("sums major penalties and caps at the provided cap", () => {
    const rules = [rule("m", "major")]
    expect(rulePenalty([inf("m"), inf("m"), inf("m")], rules, { major: 15, minor: 5 }, 40)).toBe(40)
  })
  it("treats unknown ruleIds as minor (defensive fallback)", () => {
    expect(rulePenalty([inf("unknown")], [], { major: 15, minor: 5 }, 40)).toBe(5)
  })
})
