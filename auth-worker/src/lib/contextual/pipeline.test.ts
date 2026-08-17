import { describe, expect, it } from "vitest"
import { runSpan, type RunSpanDeps } from "./pipeline"
import { construalJson, draftJson, pair, scriptedLlm, voteJson } from "./test-helpers"
import type { LlmCall, LintFlag, SceneBriefDraft, Scope, SpanDraft, SpanSeed, StagedOutcome } from "./types"

const seed: SpanSeed = {
  id: "span1",
  fileId: "f1",
  anchorCellId: "c1",
  startCellId: "c1",
  endCellId: "c3",
  seedSource: "canonical-ref",
}

const pairs = [
  pair("c1", { canonicalRef: "MRK 1:1" }),
  pair("c2", { canonicalRef: "MRK 1:2" }),
  pair("c3", { canonicalRef: "MRK 1:3" }),
]

const scope: Scope = {
  projectId: "p1",
  fileId: "f1",
  targetLang: "xx",
  orderedCellIds: pairs.map((p) => p.cellId),
  untranslatedCellIds: pairs.map((p) => p.cellId),
  fileKind: "usfm",
}

// 5 validated examples / target 10 = 0.5 coverage — at the low-risk floor.
const examples = Array.from({ length: 5 }, (_, i) => ({
  cellId: `ex${i + 1}`,
  source: `example source ${i + 1}`,
  target: `example target ${i + 1}`,
  validated: true,
}))

interface Captured {
  briefs: SceneBriefDraft[]
  linted: SpanDraft[]
  staged: SpanDraft[]
}

function makeDeps(
  llm: LlmCall,
  over: Partial<RunSpanDeps> = {},
): { deps: RunSpanDeps; captured: Captured } {
  const captured: Captured = { briefs: [], linted: [], staged: [] }
  const deps: RunSpanDeps = {
    seed,
    scope,
    pairs,
    neighborBriefs: [],
    layerAbove: [],
    examples,
    llm,
    persistBrief: async (brief) => {
      captured.briefs.push(brief)
      return "sb1"
    },
    lint: async (draft): Promise<LintFlag[]> => {
      captured.linted.push(draft)
      return []
    },
    stage: async (draft): Promise<StagedOutcome> => {
      captured.staged.push(draft)
      return {
        proposalId: "prop1",
        spanId: draft.spanId,
        stagedCellIds: draft.cells.map((c) => c.cellId),
        verdicts: {},
      }
    },
    ...over,
  }
  return { deps, captured }
}

describe("runSpan — happy path (low risk)", () => {
  it("construes, summarizes, persists, drafts, verifies (ambiguity only), stages, reports", async () => {
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true, openQuestions: ["is the quotation ironic?"] }), // construe (mid)
      "A teacher addresses a crowd; keep the irony question open.", // summarize (fast)
      draftJson([
        { i: 1, t: "draft one" },
        { i: 2, t: "draft two" },
        { i: 3, t: "draft three" },
      ]), // draft (mid)
      voteJson(true, [
        { i: 1, approve: true },
        { i: 2, approve: true },
        { i: 3, approve: true },
      ]), // verify_ambiguity (deep)
    ])
    const { deps, captured } = makeDeps(llm)
    const report = await runSpan(deps)

    expect(report.incomplete).toBe(false)
    expect(report.cellsStaged).toEqual(["c1", "c2", "c3"])
    expect(report.cellsSkipped).toEqual([])
    expect(report.ambiguities).toBe(1)
    // fast(1) + 2×mid(5) + deep(25) = 36 units, 4 calls.
    expect(report.unitsUsed).toBe(36)
    expect(report.callsUsed).toBe(4)

    // Brief persisted with the register and provenance before drafting.
    expect(captured.briefs).toHaveLength(1)
    expect(captured.briefs[0].ambiguityRegister).toEqual([
      { id: "span1:amb:1", question: "is the quotation ironic?" },
    ])
    expect(captured.briefs[0].l1Summary).toContain("irony")
    expect(captured.briefs[0].provenance.closureExit).toBe("model-closed")

    // Staged draft carries provenance: sceneBriefId + hashed promptVersion + exampleIds.
    expect(captured.staged).toHaveLength(1)
    expect(captured.staged[0].sceneBriefId).toBe("sb1")
    expect(captured.staged[0].promptVersion).toMatch(/^contextual-draft-v2:[0-9a-f]{8}$/)
    expect(captured.staged[0].exampleIds).toEqual(["ex1", "ex2", "ex3", "ex4", "ex5"])

    // Low risk → the panel never engaged: exactly one deep call (ambiguity).
    expect(calls.filter((c) => c.tier === "deep")).toHaveLength(1)
    // The performer prompt carries the scene brief and the register as hard constraints.
    const draftCall = calls[2]
    expect(draftCall.system).toContain("keep the irony question open")
    expect(draftCall.system).toContain("do NOT resolve")
    expect(draftCall.system).toContain("span1:amb:1")
    // The verifier saw brief + draft, never the performer's system prompt.
    const verifyCall = calls[3]
    expect(verifyCall.user).toContain("draft one")
    expect(verifyCall.system).not.toContain("You are the PERFORMER")
  })

  it("skips already-translated cells and reports a no-op span cleanly", async () => {
    const { llm, calls } = scriptedLlm([])
    const translated = pairs.map((p) => ({ ...p, target: "done", validated: true }))
    const { deps, captured } = makeDeps(llm, { pairs: translated })
    const report = await runSpan(deps)
    expect(report.cellsStaged).toEqual([])
    expect(report.incomplete).toBe(false)
    expect(report.notes.join(" ")).toContain("no untranslated cells")
    expect(calls).toHaveLength(0)
    expect(captured.briefs).toHaveLength(0)
  })
})

describe("runSpan — redraft loop", () => {
  it("redrafts rejected cells ONCE with constraints, then skips with reason", async () => {
    // 3 open questions → high risk → full panel.
    const openQuestions = ["q1?", "q2?", "q3?"]
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true, openQuestions }), // construe
      "Scene summary.", // summarize
      draftJson([
        { i: 1, t: "keep me" },
        { i: 2, t: "too clear" },
        { i: 3, t: "keep me too" },
      ]), // draft attempt 1
      voteJson(true), // verify_force
      voteJson(true, [
        { i: 1, approve: true },
        { i: 2, approve: false, reason: "resolves span1:amb:2" },
        { i: 3, approve: true },
      ]), // verify_ambiguity — veto on c2
      voteJson(true), // verify_naturalness
      (req) => {
        // Redraft attempt 2: only the rejected cell, constraints attached.
        expect(req.user).toContain("Translate these 1 segments")
        expect(req.user).toContain("Constraints from review")
        expect(req.user).toContain("resolves span1:amb:2")
        return draftJson([{ i: 1, t: "still too clear" }])
      },
      voteJson(true), // verify_force (round 2)
      voteJson(false, [{ i: 1, approve: false, reason: "still resolves span1:amb:2" }]), // ambiguity again
      voteJson(true), // verify_naturalness (round 2)
    ])
    const { deps, captured } = makeDeps(llm)
    const report = await runSpan(deps)

    expect(report.cellsStaged).toEqual(["c1", "c3"])
    expect(report.cellsSkipped).toEqual([
      { cellId: "c2", reason: "rejected by quorum twice: ambiguity: still resolves span1:amb:2" },
    ])
    // A twice-rejected cell is dropped, not shipped — and that is not "incomplete",
    // it is a named skip.
    expect(report.incomplete).toBe(false)
    expect(report.ambiguities).toBe(3)
    expect(captured.staged).toHaveLength(1)
    expect(captured.staged[0].cells.map((c) => c.text)).toEqual(["keep me", "keep me too"])
    // Full panel ran twice: construe + summarize + 2×(draft + 3 verifiers) = 10 calls.
    expect(calls).toHaveLength(10)
    expect(report.unitsUsed).toBe(5 + 1 + 2 * (5 + 25 + 25 + 5))
  })
})

describe("runSpan — partial failure paths", () => {
  it("marks the span incomplete when construal exhausts its budget; every cell named", async () => {
    let n = 0
    const { llm } = scriptedLlm(
      Array.from({ length: 10 }, () => () => construalJson({ closed: false, situation: `v${++n}`, openQuestions: ["q?"] })),
    )
    // Wider file: the window can keep growing, so the loop hits the unit
    // budget (12 allows 2 mid rounds) instead of exhausting the window.
    const widePairs = [
      ...Array.from({ length: 8 }, (_, i) => pair(`x${i + 1}`)),
      ...pairs,
      ...Array.from({ length: 8 }, (_, i) => pair(`y${i + 1}`)),
    ]
    const { deps, captured } = makeDeps(llm, {
      pairs: widePairs,
      budget: { unitsUsed: 0, callsUsed: 0, maxUnits: 12, maxCalls: 24 },
    })
    const report = await runSpan(deps)

    expect(report.incomplete).toBe(true)
    expect(report.incompleteReasons.join(" ")).toContain("did not close")
    expect(report.cellsStaged).toEqual([])
    expect(report.cellsSkipped.map((s) => s.cellId)).toEqual(["c1", "c2", "c3"])
    expect(report.cellsSkipped.every((s) => s.reason.includes("construal incomplete"))).toBe(true)
    expect(captured.briefs).toHaveLength(0)
    expect(captured.staged).toHaveLength(0)
  })

  it("mandatory verify_ambiguity failing twice = barrier unmet: nothing staged, incomplete", async () => {
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true, openQuestions: ["q?"] }), // construe
      "Scene summary.", // summarize
      draftJson([
        { i: 1, t: "d1" },
        { i: 2, t: "d2" },
        { i: 3, t: "d3" },
      ]), // draft
      "not json at all", // verify_ambiguity — unparseable
      "still not json", // barrier retry — unparseable again
    ])
    const { deps, captured } = makeDeps(llm)
    const report = await runSpan(deps)

    expect(report.incomplete).toBe(true)
    expect(report.incompleteReasons.join(" ")).toContain("barrier unmet")
    expect(report.incompleteReasons.join(" ")).toContain("MISSING")
    expect(report.cellsStaged).toEqual([])
    expect(report.cellsSkipped.map((s) => s.cellId).sort()).toEqual(["c1", "c2", "c3"])
    expect(captured.staged).toHaveLength(0)
    // The retry happened (2 deep calls), then the pipeline stopped — no silent continuation.
    expect(calls.filter((c) => c.tier === "deep")).toHaveLength(2)
    // The brief itself survives for human review (persist happened before drafting).
    expect(captured.briefs).toHaveLength(1)
  })

  it("reports a failed draft (unparseable model output) as skipped work, not silence", async () => {
    const { llm } = scriptedLlm([
      construalJson({ closed: true, openQuestions: [] }),
      "Scene summary.",
      "no array here", // draft attempt 1 fails to parse
    ])
    const { deps, captured } = makeDeps(llm)
    const report = await runSpan(deps)

    expect(report.incomplete).toBe(true)
    expect(report.incompleteReasons.join(" ")).toContain("draft attempt 1 failed")
    expect(report.cellsSkipped.map((s) => s.cellId)).toEqual(["c1", "c2", "c3"])
    expect(captured.staged).toHaveLength(0)
  })
})
