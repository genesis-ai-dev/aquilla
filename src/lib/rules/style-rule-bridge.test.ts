import { describe, expect, it } from "vitest"

import {
  compileStyleRulesToTranslationRules,
  isLibraryRuleId,
  LIBRARY_RULE_ID_PREFIX,
  styleRuleIdFromRuleId,
} from "./style-rule-bridge"
import type { StyleRule } from "./style-rule-types"

function styleRule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: "r1",
    orgId: null,
    projectId: "p1",
    instruction: "Do not translate the tetragrammaton as a common noun.",
    category: "terminology",
    scope: "global",
    conditions: null,
    examples: null,
    exceptions: null,
    source: null,
    checkSpec: { type: "target-forbids", targetPattern: "\\bgod\\b" },
    severity: "major",
    enabled: true,
    status: "approved",
    humanEdited: false,
    provenance: null,
    createdBy: "alice",
    reviewedBy: "bob",
    version: 1,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  }
}

describe("compileStyleRulesToTranslationRules", () => {
  it("projects an approved, enabled, check-bearing rule onto the engine shape", () => {
    const [compiled] = compileStyleRulesToTranslationRules([styleRule()])

    expect(compiled).toEqual({
      id: "lib:r1",
      name: "Do not translate the tetragrammaton as a common noun",
      description: "Do not translate the tetragrammaton as a common noun.",
      severity: "major",
      source: "llm",
      scope: "project",
      check: { type: "target-forbids", targetPattern: "\\bgod\\b" },
      enabled: true,
      createdAt: "2026-08-18T00:00:00.000Z",
    })
  })

  it("skips instruction-only rules — they reach the model through the prompt", () => {
    expect(compileStyleRulesToTranslationRules([styleRule({ checkSpec: null })])).toEqual([])
  })

  it("never lints on behalf of a rule a human has not approved", () => {
    const unapproved = compileStyleRulesToTranslationRules([
      styleRule({ id: "r2", status: "proposed" }),
      styleRule({ id: "r3", status: "rejected" }),
      styleRule({ id: "r4", status: "archived" }),
    ])
    expect(unapproved).toEqual([])
  })

  it("skips disabled rules", () => {
    expect(compileStyleRulesToTranslationRules([styleRule({ enabled: false })])).toEqual([])
  })

  it("compiles every eligible rule and preserves input order", () => {
    const compiled = compileStyleRulesToTranslationRules([
      styleRule({ id: "a" }),
      styleRule({ id: "b", checkSpec: null }),
      styleRule({ id: "c", severity: "minor" }),
    ])
    expect(compiled.map((r) => r.id)).toEqual(["lib:a", "lib:c"])
    expect(compiled[1].severity).toBe("minor")
  })

  it("keeps a short instruction whole as the name and never elides mid-word", () => {
    const short = compileStyleRulesToTranslationRules([styleRule({ instruction: "Keep numerals." })])
    expect(short[0].name).toBe("Keep numerals")

    const long = compileStyleRulesToTranslationRules([
      styleRule({ instruction: "Always preserve the original chapter and verse numbering exactly" }),
    ])
    expect(long[0].name.endsWith("…")).toBe(true)
    expect(long[0].name.length).toBeLessThanOrEqual(61)
    expect(long[0].name).not.toMatch(/\s…$/)
  })

  it("carries an org-owned library rule through as a project-scoped check", () => {
    const [compiled] = compileStyleRulesToTranslationRules([
      styleRule({ orgId: 7, projectId: null }),
    ])
    expect(compiled.scope).toBe("project")
  })
})

describe("library rule ids", () => {
  it("round-trips the style-rule id through the prefix", () => {
    const [compiled] = compileStyleRulesToTranslationRules([styleRule({ id: "abc-123" })])
    expect(compiled.id).toBe(`${LIBRARY_RULE_ID_PREFIX}abc-123`)
    expect(isLibraryRuleId(compiled.id)).toBe(true)
    expect(styleRuleIdFromRuleId(compiled.id)).toBe("abc-123")
  })

  it("does not claim ids belonging to the other rule families", () => {
    expect(isLibraryRuleId("builtin:double-space")).toBe(false)
    expect(isLibraryRuleId("term:concept-1:approved")).toBe(false)
    expect(styleRuleIdFromRuleId("builtin:double-space")).toBeNull()
  })
})
