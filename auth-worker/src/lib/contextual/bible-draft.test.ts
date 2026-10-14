// AQU-1690: the drafter and the verifiers see each cell's Bible facts, and
// the few-shot examples are chosen by pack features.
//
// WHY: the drafter that knows "Jesus → the woman, a level-2 quote inside the
// level-1 reply" can place the marks; the force verifier that sees the same
// facts can reject a draft that gives the words to the wrong speaker. And
// the examples that teach a voice should be that voice's validated lines,
// not whatever happens to come first in the file.

import { describe, expect, it } from "vitest"
import { CONTEXTUAL_PROMPT_VERSION, performSpan } from "./draft"
import { verifySpan } from "./verify"
import { examplesForSpan, quoteShape } from "./bible-examples"
import { jhn4BibleData, jhn4Pairs } from "./bible-test-helpers"
import { draftJson, pair, scriptedLlm, voteJson } from "./test-helpers"
import { createRunBudget } from "./types"

const sceneBrief = { id: "sb1", spanId: "span-jhn4", l1Summary: "Jesus and the Samaritan woman at the well.", ambiguityRegister: [] }

describe("draft prompt — Bible facts", () => {
  it("puts a Facts line under each of JHN 4:7–4:10 with speaker → addressee and where each quote opens and closes", async () => {
    const data = await jhn4BibleData()
    const { llm, calls } = scriptedLlm([draftJson([1, 2, 3, 4].map((i) => ({ i, t: `t${i}` })))])
    const result = await performSpan({
      sceneBrief,
      pairs: jhn4Pairs(),
      examples: [],
      precedingValidated: [],
      facts: data.draftLines,
      llm,
      budget: createRunBudget(),
    })
    expect(result.ok).toBe(true)
    const user = calls[0].user
    expect(user).toContain(
      "1. [JHN 4:7] A woman of Samaria came to draw water. Jesus said to her, “Give me a drink.”\n   Facts: speech Jesus [person:Jesus.2] → Samaritan woman [local:JHN:n43004007002], quote level 1 opens and closes here",
    )
    expect(user).toContain("Facts: narration only, no speech; named: disciples")
    expect(user).toContain("Facts: speech Samaritan woman [local:JHN:n43004007002] → Jesus [person:Jesus.2], quote level 1 opens and closes here")
    expect(user).toContain("quote level 2 opens and closes here")
    expect(calls[0].system).toContain("Bible data — given facts")
    expect(CONTEXTUAL_PROMPT_VERSION).toBe("contextual-draft-v4")
    expect(result.ok && result.draft.promptVersion.startsWith("contextual-draft-v4:")).toBe(true)
  })

  it("keeps the old prompt when there are no facts", async () => {
    const { llm, calls } = scriptedLlm([draftJson([{ i: 1, t: "t" }])])
    await performSpan({
      sceneBrief,
      pairs: [pair("c1", { canonicalRef: "MRK 1:1" })],
      examples: [],
      precedingValidated: [],
      llm,
      budget: createRunBudget(),
    })
    expect(calls[0].user).not.toContain("Facts:")
    expect(calls[0].system).not.toContain("Bible data")
  })

  it("gives the verifiers the same facts as the drafter", async () => {
    const data = await jhn4BibleData()
    const pairs = jhn4Pairs()
    const { llm, calls } = scriptedLlm([voteJson(true)])
    await verifySpan("force", {
      sceneBrief,
      draft: { spanId: "s", sceneBriefId: "sb1", cells: [{ cellId: "c9", text: "draft" }], exampleIds: [], promptVersion: "v" },
      pairs,
      facts: data.draftLines,
      llm,
      budget: createRunBudget(),
    })
    expect(calls[0].user).toContain("facts:  speech Samaritan woman [local:JHN:n43004007002] → Jesus [person:Jesus.2]")
    expect(calls[0].system).toContain("a draft that contradicts it fails")
  })
})

describe("examplesForSpan", () => {
  // Validated lines: v1 and v2 are narration, v3 is the woman speaking, v4 is Jesus speaking.
  const validatedPairs = [
    pair("v1", { canonicalRef: "JHN 4:8", validated: true, target: "narration A" }),
    pair("v2", { canonicalRef: "JHN 4:8", validated: true, target: "narration B" }),
    pair("v3", { canonicalRef: "JHN 4:9", validated: true, target: "the woman asks" }),
    pair("v4", { canonicalRef: "JHN 4:7", validated: true, target: "Jesus asks" }),
  ]

  async function factsFor(): Promise<Awaited<ReturnType<typeof jhn4BibleData>>["facts"]> {
    const data = await jhn4BibleData({ pairs: [...jhn4Pairs(), ...validatedPairs] })
    return data.facts
  }

  it("prefers validated pairs where the same person speaks", async () => {
    const facts = await factsFor()
    const span = jhn4Pairs().filter((p) => p.cellId === "c10") // Jesus speaks
    const chosen = examplesForSpan(validatedPairs, span, 1, facts)
    expect(chosen.map((e) => e.cellId)).toEqual(["v4"])
  })

  it("falls back to file order when no validated pair shares a feature, or without facts", async () => {
    const facts = await factsFor()
    const narrationSpan = jhn4Pairs().filter((p) => p.cellId === "c8")
    // The span names the disciples; v1 and v2 do too, so they score — use a span with nothing in common instead.
    const strangers = [pair("x1", { canonicalRef: "JHN 4:9", validated: true, target: "x" })]
    expect(examplesForSpan(strangers, narrationSpan, 2, new Map()).map((e) => e.cellId)).toEqual(["x1"])
    expect(examplesForSpan(validatedPairs, narrationSpan, 2).map((e) => e.cellId)).toEqual(["v1", "v2"])
    expect(examplesForSpan(validatedPairs.slice(0, 2), jhn4Pairs().filter((p) => p.cellId === "c7"), 2, facts).map((e) => e.cellId))
      .toEqual(["v1", "v2"])
  })

  it("describes quotation shapes the way the ranking compares them", async () => {
    const facts = await factsFor()
    expect(quoteShape(facts.get("c10")!)).toBe("1oc+2oc")
    expect(quoteShape(facts.get("c8")!)).toBe("none")
  })
})
