import { describe, it, expect } from "vitest"
import { computeCompositeHealth, computeOneCellHealth, type CompositeInput, type CompositeCell } from "./compute"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"

function sp(cellId: string, cw: number, tokens: string[] = []): ScoredPair {
  return { cellId, fileId: "f", source: "", target: "", score: cw, matchedTokens: tokens, coverageWeight: cw }
}

function cell(
  id: string,
  partial: Partial<CompositeCell> = {},
): CompositeCell {
  return {
    id, fileId: "f",
    translated: "x", validatorCount: 0,
    examples: undefined, infractions: [],
    branchingSource: [], branchingTarget: [],
    plainSource: [], plainTarget: [],
    ...partial,
  }
}

function baseInput(cells: CompositeCell[]): CompositeInput {
  return {
    cells, rules: [], config: HEALTH_DEFAULTS, requiredValidations: 2,
  }
}

describe("computeCompositeHealth", () => {
  it("empty translated cells skipped entirely", () => {
    const { healthMap, breakdownMap } = computeCompositeHealth(baseInput([cell("a", { translated: "" })]))
    expect(healthMap.has("a")).toBe(false)
    expect(breakdownMap.has("a")).toBe(false)
  })

  it("any validation overrides ancestry+neighborhood — validated cell with no ancestry reaches 100", () => {
    // Before the validation-override fix this scored 80: 100 minus the
    // unknown-ancestry cap of 20. The override mirrors the legacy engine —
    // a human sign-off should waive the AI-context dimensions entirely.
    const { healthMap, breakdownMap } = computeCompositeHealth(baseInput([cell("a", {
      validatorCount: 1,
    })]))
    expect(healthMap.get("a")).toBe(100)
    const b = breakdownMap.get("a")!
    expect(b.validationGap).toBe(0)
    expect(b.ancestryPenalty).toBe(0)
    expect(b.neighborhoodPenalty).toBe(0)
    expect(b.rulePenalty).toBe(0)
  })

  it("validated cell still pays rule penalties — one major violation drops score to 85", () => {
    const rule: TranslationRule = {
      id: "r1", name: "trailing-punct", description: "",
      enabled: true, severity: "major",
      checks: [], waivers: [],
    } as unknown as TranslationRule
    const infraction: RuleInfraction = {
      ruleId: "r1", message: "bad punct",
      spans: [], severity: "major",
    } as unknown as RuleInfraction
    const result = computeCompositeHealth({
      cells: [cell("a", { validatorCount: 1, infractions: [infraction] })],
      rules: [rule],
      config: HEALTH_DEFAULTS,
      requiredValidations: 1,
    })
    // rulePenalties.major = 15 by default; validated cell score = 100 - 15.
    expect(result.healthMap.get("a")).toBe(85)
  })

  it("validated cell with violations beyond the rule cap clamps at 100 - cap (not negative)", () => {
    const rule: TranslationRule = {
      id: "r1", name: "many", description: "",
      enabled: true, severity: "major",
      checks: [], waivers: [],
    } as unknown as TranslationRule
    // Five major infractions × 15 = 75, but rulePenalty cap is 40 by default,
    // so the validated cell should still score 60 — not 25, and certainly
    // not below zero.
    const infractions: RuleInfraction[] = Array.from({ length: 5 }, (): RuleInfraction => ({
      ruleId: "r1", message: "bad", spans: [], severity: "major",
    } as unknown as RuleInfraction))
    const result = computeCompositeHealth({
      cells: [cell("a", { validatorCount: 1, infractions })],
      rules: [rule],
      config: HEALTH_DEFAULTS,
      requiredValidations: 1,
    })
    expect(result.healthMap.get("a")).toBe(60)
  })

  it("validated cell uses requiredValidations=1 as the override floor (matches legacy 'self' branch)", () => {
    // requiredValidations is 2 but the cell has only 1 validator — legacy
    // health-engine.ts:38-47 still returns 100 for any of full/self/others,
    // so the composite override must too.
    const { healthMap } = computeCompositeHealth(baseInput([cell("a", {
      validatorCount: 1,
    })]))
    expect(healthMap.get("a")).toBe(100)
  })

  it("unvalidated cell still pays all four penalties (regression guard for the non-override branch)", () => {
    const { healthMap, breakdownMap } = computeCompositeHealth(baseInput([cell("a")]))
    const score = healthMap.get("a")!
    // 100 - 60 (validationGap) - 20 (ancestry) - 25 (neighborhood) = -5, clamped to 0
    expect(score).toBe(0)
    const b = breakdownMap.get("a")!
    expect(b.validationGap).toBe(60)
    expect(b.ancestryPenalty).toBe(20)
    expect(b.neighborhoodPenalty).toBe(25)
    expect(b.rulePenalty).toBe(0)
  })

  it("validated cell still surfaces ancestry diagnostics in the breakdown signals", () => {
    // Even though ancestry doesn't penalize a validated cell, the popover
    // should still show which examples the LLM used for transparency.
    const { breakdownMap } = computeCompositeHealth(baseInput([cell("a", {
      validatorCount: 1,
      examples: [{ cellId: "src1", weight: 0.7 }, { cellId: "src2", weight: 0.3 }],
    })]))
    const b = breakdownMap.get("a")!
    expect(b.ancestryPenalty).toBe(0)
    expect(b.signals.ancestryExamples).toHaveLength(2)
    expect(b.signals.ancestryExamples[0].cellId).toBe("src1")
  })

  it("file and project health are means over non-empty cells", () => {
    const cells = [
      cell("a", { translated: "" }),   // skipped
      cell("b", { validatorCount: 2, branchingSource: [sp("x", 1, ["t"])], branchingTarget: [sp("x", 1, ["t"])], plainSource: [sp("x", 1)], plainTarget: [sp("x", 1)], examples: [{ cellId: "o", weight: 1 }] }),
      cell("c"),
    ]
    const inp = baseInput(cells)
    const r = computeCompositeHealth(inp)
    expect(r.fileHealth.get("f")).toBeDefined()
    expect(r.projectHealth).toBeGreaterThan(0)
    expect(r.breakdownMap.size).toBe(2)  // a is skipped (empty translated)
  })
})

describe("computeOneCellHealth", () => {
  it("validatorCount=0 falls through to the full four-penalty formula", () => {
    const { score, breakdown } = computeOneCellHealth(
      cell("a"), [], HEALTH_DEFAULTS, 2, new Map(),
    )
    expect(breakdown.validationGap).toBeGreaterThan(0)
    expect(breakdown.ancestryPenalty).toBeGreaterThan(0)
    expect(breakdown.neighborhoodPenalty).toBeGreaterThan(0)
    expect(score).toBeLessThan(100)
  })

  it("validatorCount=1 skips validationGap, ancestry, neighborhood; rule penalty still applies", () => {
    const { score, breakdown } = computeOneCellHealth(
      cell("a", { validatorCount: 1 }), [], HEALTH_DEFAULTS, 2, new Map(),
    )
    expect(breakdown.validationGap).toBe(0)
    expect(breakdown.ancestryPenalty).toBe(0)
    expect(breakdown.neighborhoodPenalty).toBe(0)
    expect(breakdown.rulePenalty).toBe(0)
    expect(score).toBe(100)
  })
})
