import { describe, expect, it } from "vitest"
import { classifyRisk, SUPPORT_RATIO_LOW_THRESHOLD } from "./router"
import type { AmbiguityEntry, LintFlag, SpanDraft } from "./types"

const draft: SpanDraft = {
  spanId: "span1",
  sceneBriefId: "sb1",
  cells: [{ cellId: "c1", text: "t1" }],
  exampleIds: [],
  promptVersion: "v",
}

const flag = (ruleId: string): LintFlag => ({ spanId: "span1", cellId: "c1", ruleId, message: "m" })
const amb = (id: string): AmbiguityEntry => ({ id, question: "q?" })

describe("classifyRisk", () => {
  it("routes a clean span low: ambiguity verifier only — never skipped", () => {
    const risk = classifyRisk(draft, [], [amb("a1")], 1.0, { rounds: 2, exit: "model-closed" })
    expect(risk.level).toBe("low")
    expect(risk.verifiers).toEqual(["ambiguity"])
    expect(risk.sourceFindingIds).toEqual([])
  })

  it("a large ambiguity register (≥3) routes high with the full panel", () => {
    const register = [amb("a1"), amb("a2"), amb("a3")]
    const risk = classifyRisk(draft, [], register, 1.0)
    expect(risk.level).toBe("high")
    expect(risk.verifiers).toEqual(["force", "ambiguity", "naturalness"])
    expect(risk.sourceFindingIds).toEqual(["a1", "a2", "a3"])
    expect(risk.reasons.join(" ")).toContain("register")
  })

  it("any lint flag routes high and carries the rule ids as findings", () => {
    const risk = classifyRisk(draft, [flag("rule-x")], [], 1.0)
    expect(risk.level).toBe("high")
    expect(risk.sourceFindingIds).toContain("rule-x")
  })

  it("weak validated-example coverage (<0.5) routes high", () => {
    expect(classifyRisk(draft, [], [], 0.49).level).toBe("high")
    expect(classifyRisk(draft, [], [], 0.5).level).toBe("low")
  })

  it("a hard-fought closure (≥4 rounds or a budget exit) routes high", () => {
    expect(classifyRisk(draft, [], [], 1.0, { rounds: 4, exit: "fixpoint" }).level).toBe("high")
    expect(classifyRisk(draft, [], [], 1.0, { rounds: 2, exit: "budget" }).level).toBe("high")
    expect(classifyRisk(draft, [], [], 1.0, { rounds: 3, exit: "fixpoint" }).level).toBe("low")
  })

  it("ignores the support check when it abstained (a thin corpus routes nothing high)", () => {
    const risk = classifyRisk(draft, [], [], 1.0, undefined, {
      applicable: false,
      ratio: 0,
      riskyCellIds: ["c1"],
    })
    expect(risk.level).toBe("low")
    expect(risk.sourceFindingIds).toEqual([])
  })

  it("a CONFIRMED unsupported cell routes high and is named as a finding", () => {
    const risk = classifyRisk(draft, [], [], 1.0, undefined, {
      applicable: true,
      ratio: 0.9,
      riskyCellIds: ["c1"],
    })
    expect(risk.level).toBe("high")
    expect(risk.verifiers).toEqual(["force", "ambiguity", "naturalness"])
    expect(risk.sourceFindingIds).toEqual(["support:c1"])
    expect(risk.reasons.join(" ")).toContain("unattested")
  })

  it("a code flag the fast model cleared does NOT route high", () => {
    const risk = classifyRisk(draft, [], [], 1.0, undefined, {
      applicable: true,
      ratio: 0.95,
      riskyCellIds: [],
    })
    expect(risk.level).toBe("low")
    expect(risk.reasons[0]).toContain("span support 0.95")
  })

  it("a span-wide support collapse routes high even with no single cell confirmed", () => {
    const risk = classifyRisk(draft, [], [], 1.0, undefined, {
      applicable: true,
      ratio: SUPPORT_RATIO_LOW_THRESHOLD - 0.01,
      riskyCellIds: [],
    })
    expect(risk.level).toBe("high")
    expect(risk.reasons.join(" ")).toContain("drifted off its retrieval")
  })

  it("reasons are always populated (inspectable routing, both directions)", () => {
    expect(classifyRisk(draft, [], [], 1.0).reasons.length).toBeGreaterThan(0)
    expect(classifyRisk(draft, [flag("r")], [], 0).reasons.length).toBeGreaterThan(1)
  })
})
