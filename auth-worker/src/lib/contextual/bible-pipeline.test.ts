// AQU-1690: runSpan with Bible data — bounded repair.
//
// WHY: a draft the verifier panel passed, whose only problem is a Bible data
// expectation (the woman's quotation closed after the narrator's aside), is
// worth one cheap redraft with a precise instruction — not a second deep
// panel, and not a skip. The attempt limit stays 2. What survives goes to a
// person with its code. A SHADOW Jev answer must never cost a redraft; an
// ACTIVE one carries its constraint.

import { describe, expect, it } from "vitest"
import { decodeBibleParams } from "../../../../db/shared/bible-checks/params"
import { runSpan, type RunSpanDeps } from "./pipeline"
import { spanBible, type SpanBible } from "./bible-span"
import { bibleCodeSeverity } from "./bible-gates"
import { fallbackTriage } from "./triage"
import { lintSpanDraft } from "./lint-node"
import { jhn4BibleData, jhn4Pairs } from "./bible-test-helpers"
import { construalJson, draftJson, scriptedLlm, voteJson } from "./test-helpers"
import type { JudgeResult } from "./judge-expectations"
import type { LlmRequest, SpanDraft, StagedOutcome } from "./types"

const ASIDE_INSIDE =
  "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me, a woman of Samaria? (For Jews have no dealings with Samaritans.)”"
const CORRECT_4_9 =
  "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me, a woman of Samaria?” (For Jews have no dealings with Samaritans.)"

// 5 validated examples / 10 = 0.5 coverage: low risk, so the panel is the ambiguity vote alone.
const examples = Array.from({ length: 5 }, (_, i) => ({ cellId: `ex${i}`, source: `s${i}`, target: `t${i}`, validated: true }))

/** One span over JHN 4:9 alone, so every scripted reply is about c9. */
async function deps(bible: SpanBible | undefined, llm: RunSpanDeps["llm"]): Promise<{ deps: RunSpanDeps; staged: SpanDraft[] }> {
  const data = await jhn4BibleData()
  const pairs = jhn4Pairs()
  const staged: SpanDraft[] = []
  return {
    staged,
    deps: {
      seed: { id: "span-c9", fileId: "f1", anchorCellId: "c9", startCellId: "c9", endCellId: "c9", seedSource: "canonical-ref" },
      scope: { projectId: "p1", fileId: "f1", targetLang: "en", orderedCellIds: [], untranslatedCellIds: [], fileKind: "usfm" },
      pairs,
      neighborBriefs: [],
      layerAbove: [],
      examples,
      ...(bible ? { bible } : {}),
      llm,
      persistBrief: async () => "sb1",
      lint: async (draft) =>
        lintSpanDraft([], pairs, draft, [], { expectations: data.expectations, profile: data.profile }),
      stage: async (draft): Promise<StagedOutcome> => {
        staged.push(draft)
        return { proposalId: "p", spanId: draft.spanId, stagedCellIds: draft.cells.map((c) => c.cellId), verdicts: {} }
      },
    },
  }
}

const isDraft = (req: LlmRequest) => req.label === "draft"
const isVerify = (req: LlmRequest) => (req.label ?? "").startsWith("verify")

async function bibleWith(judge?: (draft: SpanDraft) => Promise<JudgeResult>): Promise<SpanBible> {
  const data = await jhn4BibleData()
  const base = spanBible(data, { pairs: jhn4Pairs(), spanId: "span-c9" })
  if (!judge || !base.checks) return base
  return { ...base, checks: { ...base.checks, judge } }
}

describe("bounded repair of Bible data expectations", () => {
  it("redrafts a panel-approved cell ONCE with a templated constraint, skips the deep panel, and stops at 2 attempts", async () => {
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true }),
      "The woman asks Jesus for water.",
      draftJson([{ i: 1, t: ASIDE_INSIDE }]),
      voteJson(true),
      // The repair comes back still wrong: there is no third attempt.
      draftJson([{ i: 1, t: ASIDE_INSIDE }]),
    ])
    const { deps: d, staged } = await deps(await bibleWith(), llm)
    const report = await runSpan(d)

    const drafts = calls.filter(isDraft)
    expect(drafts).toHaveLength(2)
    expect(drafts[1].user).toContain(
      "Constraints from review (satisfy each): Close Samaritan woman's quotation with ” before the words that follow it in this verse",
    )
    // The repair is not re-verified: one ambiguity vote, on the first draft.
    expect(calls.filter(isVerify)).toHaveLength(1)
    // Staged, never skipped — with its code, for the stage re-check to send to a person.
    expect(report.cellsSkipped).toEqual([])
    expect(staged[0].cells).toEqual([{ cellId: "c9", text: ASIDE_INSIDE, findings: ["bkp:V2", "redrafted"] }])
    expect(report.bible).toMatchObject({ findings: { "bkp:V2": 2 }, repaired: 1 })
  })

  it("stages the repaired text when the repair works", async () => {
    const { llm } = scriptedLlm([
      construalJson({ closed: true }),
      "The woman asks Jesus for water.",
      draftJson([{ i: 1, t: ASIDE_INSIDE }]),
      voteJson(true),
      draftJson([{ i: 1, t: CORRECT_4_9 }]),
    ])
    const { deps: d, staged } = await deps(await bibleWith(), llm)
    await runSpan(d)
    expect(staged[0].cells).toEqual([{ cellId: "c9", text: CORRECT_4_9, findings: ["redrafted"] }])
  })

  it("does not repair without the checks enrichment", async () => {
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true }),
      "The woman asks Jesus for water.",
      draftJson([{ i: 1, t: ASIDE_INSIDE }]),
      voteJson(true),
    ])
    const data = await jhn4BibleData({ flags: { checks: false } })
    const { deps: d } = await deps(spanBible(data, { pairs: jhn4Pairs(), spanId: "span-c9" }), llm)
    await runSpan(d)
    expect(calls.filter(isDraft)).toHaveLength(1)
  })
})

describe("Jev answers and repair", () => {
  const judgment = (mode: "shadow" | "active"): JudgeResult => ({
    judgments: [{ cellId: "c9", check: "negation", outcome: "fail", decidedBy: "jev", mode, p: 0.05, certainty: 0.9 }],
    jevCalls: 1,
  })

  it("a SHADOW 'no' never redrafts", async () => {
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true }),
      "The woman asks Jesus for water.",
      draftJson([{ i: 1, t: CORRECT_4_9 }]),
      voteJson(true),
    ])
    const { deps: d, staged } = await deps(await bibleWith(async () => judgment("shadow")), llm)
    const report = await runSpan(d)
    expect(calls.filter(isDraft)).toHaveLength(1)
    expect(staged[0].cells[0].findings).toEqual([])
    // Recorded for the metrics, with its certainty.
    expect(report.bible?.judgments).toEqual([
      { cellId: "c9", check: "negation", outcome: "fail", mode: "shadow", decidedBy: "jev", certainty: 0.9 },
      // AQU-1701: C1 then asks JHN 4:9's Translation Question of the final draft; with no Jev side it abstains.
      { cellId: "c9", check: "tq", outcome: "abstain", mode: "shadow", decidedBy: "fallback", certainty: 0 },
    ])
  })

  it("an ACTIVE 'no' carries its constraint into the repair, and its code onto the draft", async () => {
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true }),
      "The woman asks Jesus for water.",
      draftJson([{ i: 1, t: CORRECT_4_9 }]),
      voteJson(true),
      draftJson([{ i: 1, t: CORRECT_4_9 }]),
    ])
    const { deps: d, staged } = await deps(await bibleWith(async () => judgment("active")), llm)
    await runSpan(d)
    const drafts = calls.filter(isDraft)
    expect(drafts).toHaveLength(2)
    expect(drafts[1].user).toContain('Keep the negation: the source says "not".')
    expect(staged[0].cells[0].findings).toEqual(["bkp:M3", "redrafted"])
  })
})

// AQU-1701: C1 runs once the span's drafting is settled, on the FINAL text.
// WHY: a Translation Question's answer is not a constraint a drafter can
// satisfy blindly, so a "no" is a finding for a person to review — it must
// never cost a redraft. In shadow it must not even reach the reviewer.
describe("C1 — Translation Questions after drafting", () => {
  const sayNo = (modes?: { tq: "active" }) => {
    const calls: string[][] = []
    const judge = {
      cache: new Map<string, number>(),
      ...(modes ? { modes } : {}),
      decide: async (input: { questions: Record<string, unknown> }) => {
        calls.push(Object.keys(input.questions))
        const answers = Object.fromEntries(Object.keys(input.questions).map((k) => [k, { kind: "noul" as const, p: 0.05 }]))
        return { answers, decidedBy: "model" as const, model: "typesafe/jev-1.13", usage: null }
      },
    }
    return { judge, calls }
  }
  const script = () =>
    scriptedLlm([construalJson({ closed: true }), "The woman asks Jesus for water.", draftJson([{ i: 1, t: CORRECT_4_9 }]), voteJson(true)])

  it("a SHADOW 'no' adds no finding and no redraft, and is recorded for maintainers", async () => {
    const { judge, calls: jevCalls } = sayNo()
    const { llm, calls } = script()
    const data = await jhn4BibleData()
    const { deps: d, staged } = await deps(spanBible(data, { pairs: jhn4Pairs(), spanId: "span-c9", judge }), llm)
    const report = await runSpan(d)
    expect(calls.filter(isDraft)).toHaveLength(1)
    // The span's questions, then C1's: JHN 4:9's Translation Question, once its draft is final.
    expect(jevCalls.at(-1)).toEqual(["q0"])
    expect(staged[0].cells[0]).toEqual({ cellId: "c9", text: CORRECT_4_9, findings: [] })
    expect(report.bible?.judgments).toContainEqual({ cellId: "c9", check: "tq", outcome: "fail", mode: "shadow", decidedBy: "jev", certainty: 0.9 })
  })

  it("an ACTIVE 'no' is a bkp:C1 finding with the question and its answer on the staged draft — never a redraft", async () => {
    const { judge } = sayNo({ tq: "active" })
    const { llm, calls } = script()
    const data = await jhn4BibleData()
    const { deps: d, staged } = await deps(spanBible(data, { pairs: jhn4Pairs(), spanId: "span-c9", judge }), llm)
    await runSpan(d)
    expect(calls.filter(isDraft)).toHaveLength(1)
    const [cell] = staged[0].cells
    expect(cell.findings).toEqual(["bkp:C1"])
    expect(decodeBibleParams(cell.values?.["bkp:C1"])).toMatchObject({
      tq: "tq:172802",
      refs: "JHN 4:9",
      answer: "She was surprised because Jews had no dealings with the Samaritans.",
    })
    // Info: a finding for review that never sends the draft to a person on its own.
    expect(bibleCodeSeverity("bkp:C1")).toBe("info")
    expect(fallbackTriage(["bkp:C1"]).triage).toBe("advisory")
  })
})
