// AQU-1691 — the "Project decisions" block of the draft prompt.
//
// WHY: the block is HARD, so a fact that reaches the wrong passage is an
// instruction to mistranslate it. A span must see the Language profile and the
// facts for its own passage and book, and no fact scoped elsewhere. The prompt
// version must change with the block, so a draft staged under the new prompt
// can be told apart from one staged before it.

import { describe, expect, it } from "vitest"
import { CONTEXTUAL_PROMPT_VERSION, performSpan, promptFingerprint } from "./draft"
import { MAX_FACTS_PER_SPAN, projectDecisionLines } from "./project-decisions"
import { draftJson, pair, scriptedLlm } from "./test-helpers"
import { createRunBudget } from "./types"
import type { ProjectFact } from "../../../../db/shared/project-facts"

function fact(key: string, value: string, scope: ProjectFact["scope"] = {}, at = "2026-10-05T10:00:00.000Z"): ProjectFact {
  return { id: key, key, value, scope, author: "ana", at }
}

const facts = [
  fact("clusivity.ACT.16.10-17", "exclusive", { passage: { from: "ACT 16:10", to: "ACT 16:17" } }),
  fact("render.the-way", "the Way", { book: "ACT" }),
  fact("render.legion", "Legion", { book: "MRK" }),
  fact("kin.andrew-peter.relative-age", "younger", { entity: "Andrew" }),
]

describe("projectDecisionLines", () => {
  it("renders the profile, then only the facts in scope for the span", () => {
    const lines = projectDecisionLines(facts, { measures: "convert" }, ["ACT 16:11", "ACT 16:12"])
    expect(lines).toEqual([
      '- Measures (convert, transliterate or mixed): "convert"',
      '- clusivity.ACT.16.10-17 = "exclusive" (ACT 16:10–ACT 16:17)',
      '- render.the-way = "the Way" (ACT)',
      '- kin.andrew-peter.relative-age = "younger" (about Andrew)',
    ])
    expect(lines.join("\n")).not.toContain("render.legion")
  })

  it("drops the passage fact outside its verses", () => {
    const lines = projectDecisionLines(facts, {}, ["ACT 17:1"]).join("\n")
    expect(lines).not.toContain("clusivity")
    expect(lines).toContain("render.the-way")
  })

  it("is empty when the project has decided nothing", () => {
    expect(projectDecisionLines([], {}, ["ACT 16:11"])).toEqual([])
  })

  it(`caps the log at ${MAX_FACTS_PER_SPAN} facts, keeping the most specific`, () => {
    const many = Array.from({ length: MAX_FACTS_PER_SPAN + 5 }, (_, i) => fact(`k.${i}`, "v"))
    const lines = projectDecisionLines([...many, facts[0]], {}, ["ACT 16:11"])
    expect(lines).toHaveLength(MAX_FACTS_PER_SPAN)
    expect(lines[0]).toContain("clusivity.ACT.16.10-17")
  })
})

describe("the draft prompt", () => {
  const sceneBrief = { id: "sb1", spanId: "span1", l1Summary: "Paul's companions travel.", ambiguityRegister: [] }

  async function systemPromptFor(decisions?: string[]) {
    const { llm, calls } = scriptedLlm([draftJson([{ i: 1, t: "one" }])])
    const result = await performSpan({
      sceneBrief,
      pairs: [pair("c1", { canonicalRef: "ACT 16:11" })],
      examples: [],
      precedingValidated: [],
      ...(decisions ? { decisions } : {}),
      llm,
      budget: createRunBudget(),
    })
    if (!result.ok) throw new Error(result.error)
    return { system: calls[0].system, promptVersion: result.draft.promptVersion }
  }

  it("carries the decisions as a HARD block, and stamps drafts with the bumped prompt version", async () => {
    const lines = projectDecisionLines(facts, {}, ["ACT 16:11"])
    const withBlock = await systemPromptFor(lines)
    expect(withBlock.system).toContain("Project decisions — HARD constraints")
    expect(withBlock.system).toContain('clusivity.ACT.16.10-17 = "exclusive"')
    expect(withBlock.system).not.toContain("render.legion")
    expect(CONTEXTUAL_PROMPT_VERSION).toBe("contextual-draft-v4")
    expect(withBlock.promptVersion).toBe(`contextual-draft-v4:${promptFingerprint(withBlock.system)}`)

    // No decisions, no block: a project that decided nothing keeps the old wording.
    const without = await systemPromptFor()
    expect(without.system).not.toContain("Project decisions")
  })
})
