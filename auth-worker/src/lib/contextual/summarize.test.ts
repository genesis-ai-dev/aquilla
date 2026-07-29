import { describe, expect, it } from "vitest"
import { L1_MAX_CHARS, renderConstrualL2, summarizeConstrual } from "./summarize"
import { scriptedLlm } from "./test-helpers"
import { createRunBudget, type Construal } from "./types"

const construal: Construal = {
  spanId: "span1",
  situation: "a teacher addresses a crowd",
  participants: ["teacher", "crowd"],
  tenor: "authoritative",
  moves: ["summon", "teach"],
  closed: true,
  openQuestions: ["is the quotation ironic?"],
  evidenceCellIds: ["c1"],
}

describe("summarizeConstrual", () => {
  it("hard-truncates the model's L1 to the stated char budget", async () => {
    const { llm, calls } = scriptedLlm(["x".repeat(L1_MAX_CHARS + 500)])
    const result = await summarizeConstrual({ construal, llm, budget: createRunBudget() })
    expect(result.fallback).toBe(false)
    expect(result.l1Summary).toHaveLength(L1_MAX_CHARS)
    expect(calls[0].tier).toBe("fast")
    expect(calls[0].system).toContain(String(L1_MAX_CHARS))
  })

  it("falls back to truncated L2 (flagged, never silent) when the budget refuses the call", async () => {
    const { llm, calls } = scriptedLlm([])
    const result = await summarizeConstrual({
      construal,
      llm,
      budget: { unitsUsed: 200, callsUsed: 5, maxUnits: 200, maxCalls: 24 },
    })
    expect(result.fallback).toBe(true)
    expect(result.l1Summary).toContain("teacher")
    expect(result.l1Summary.length).toBeLessThanOrEqual(L1_MAX_CHARS)
    expect(calls).toHaveLength(0)
  })
})

describe("renderConstrualL2", () => {
  it("renders a deterministic markdown L2 with the open questions marked preserve", () => {
    const l2 = renderConstrualL2(construal)
    expect(l2).toContain("## Situation")
    expect(l2).toContain("- teacher")
    expect(l2).toContain("1. summon")
    expect(l2).toContain("Open questions (genuine ambiguity — preserve)")
    expect(l2).toContain("is the quotation ironic?")
    expect(renderConstrualL2(construal)).toBe(l2)
  })
})
