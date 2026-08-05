import { describe, expect, it } from "vitest"
import { performSpan, promptFingerprint, CONTEXTUAL_PROMPT_VERSION } from "./draft"
import { parseVoteReply, verifySpan, STANCES } from "./verify"
import { draftJson, pair, scriptedLlm, voteJson } from "./test-helpers"
import { createRunBudget, type SpanDraft } from "./types"

const sceneBrief = {
  id: "sb1",
  spanId: "span1",
  l1Summary: "A teacher addresses a crowd.",
  ambiguityRegister: [{ id: "span1:amb:1", question: "is 'he' the teacher?" }],
}

describe("performSpan", () => {
  it("drafts numbered cells, maps [{i,t}] back to cellIds, hashes the prompt", async () => {
    const { llm, calls } = scriptedLlm([
      draftJson([
        { i: 1, t: "one" },
        { i: 2, t: "two" },
      ]),
    ])
    const budget = createRunBudget()
    const result = await performSpan({
      sceneBrief,
      pairs: [pair("c1"), pair("c2")],
      examples: [{ cellId: "ex1", source: "s", target: "t", validated: true }],
      precedingValidated: [pair("c0", { target: "before", validated: true, canonicalRef: "MRK 1:1" })],
      llm,
      budget,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.cells).toEqual([
      { cellId: "c1", text: "one" },
      { cellId: "c2", text: "two" },
    ])
    expect(result.draft.sceneBriefId).toBe("sb1")
    expect(result.draft.exampleIds).toEqual(["ex1"])
    expect(result.missedCellIds).toEqual([])
    // promptVersion = stable FNV-1a of the effective system prompt.
    expect(result.draft.promptVersion).toBe(
      `${CONTEXTUAL_PROMPT_VERSION}:${promptFingerprint(calls[0].system)}`,
    )
    // Register rides the system prompt as a hard constraint; discourse context in user msg.
    expect(calls[0].system).toContain("span1:amb:1")
    expect(calls[0].user).toContain("Immediately preceding")
    expect(calls[0].user).toContain("imitate them")
  })

  it("names cells the model skipped (missedCellIds) instead of inventing them", async () => {
    const { llm } = scriptedLlm([draftJson([{ i: 1, t: "only one" }])])
    const result = await performSpan({
      sceneBrief,
      pairs: [pair("c1"), pair("c2")],
      examples: [],
      precedingValidated: [],
      llm,
      budget: createRunBudget(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.cells.map((c) => c.cellId)).toEqual(["c1"])
    expect(result.missedCellIds).toEqual(["c2"])
  })

  it("keeps complete approved example and preceding-context text in the prompt", async () => {
    const longSource = `start ${"complete source text ".repeat(25)}end`
    const longTarget = `start ${"complete target text ".repeat(25)}end`
    const { llm, calls } = scriptedLlm([draftJson([{ i: 1, t: "one" }])])
    await performSpan({
      sceneBrief,
      pairs: [pair("c1")],
      examples: [{ cellId: "ex-long", source: longSource, target: longTarget, validated: true }],
      precedingValidated: [pair("c0", { source: longSource, target: longTarget, validated: true })],
      llm,
      budget: createRunBudget(),
    })

    expect(calls[0].user).toContain(JSON.stringify(longSource))
    expect(calls[0].user).toContain(JSON.stringify(longTarget))
    expect(calls[0].user).toContain("end")
  })

  it("refuses to call the model past the budget", async () => {
    const { llm, calls } = scriptedLlm([])
    const result = await performSpan({
      sceneBrief,
      pairs: [pair("c1")],
      examples: [],
      precedingValidated: [],
      llm,
      budget: { unitsUsed: 199, callsUsed: 3, maxUnits: 200, maxCalls: 24 },
    })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe("verifySpan / parseVoteReply", () => {
  const draft: SpanDraft = {
    spanId: "span1",
    sceneBriefId: "sb1",
    cells: [
      { cellId: "c1", text: "one" },
      { cellId: "c2", text: "two" },
    ],
    exampleIds: [],
    promptVersion: "v",
  }

  it("stances are data: deep for force/ambiguity, mid for naturalness", () => {
    expect(STANCES.force.tier).toBe("deep")
    expect(STANCES.ambiguity.tier).toBe("deep")
    expect(STANCES.naturalness.tier).toBe("mid")
    expect(STANCES.force.stance).toContain("social force")
    expect(STANCES.ambiguity.stance).toContain("resolves")
  })

  it("returns a per-cell Vote; the verifier sees brief + draft only", async () => {
    const { llm, calls } = scriptedLlm([
      voteJson(false, [
        { i: 1, approve: true },
        { i: 2, approve: false, reason: "resolves span1:amb:1" },
      ]),
    ])
    const budget = createRunBudget()
    const result = await verifySpan("ambiguity", {
      sceneBrief,
      draft,
      pairs: [pair("c1"), pair("c2")],
      llm,
      budget,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.vote.verifier).toBe("ambiguity")
    expect(result.vote.cellVerdicts).toEqual([
      { cellId: "c1", approve: true },
      { cellId: "c2", approve: false, reason: "resolves span1:amb:1" },
    ])
    expect(calls[0].tier).toBe("deep")
    expect(calls[0].system).toContain("span1:amb:1")
    expect(calls[0].user).toContain("source of c2")
  })

  it("parseVoteReply tolerates prose around the JSON and drops malformed verdicts", () => {
    const content = `Here is my verdict:\n${voteJson(true, [
      { i: 1, approve: true },
      { i: 99, approve: false, reason: "out of range" },
    ])}\nThanks!`
    const vote = parseVoteReply(content, "force", draft)
    expect(vote?.approve).toBe(true)
    expect(vote?.cellVerdicts).toEqual([{ cellId: "c1", approve: true }])
    expect(parseVoteReply("no json", "force", draft)).toBeNull()
  })
})
