/**
 * run-state tests — frame → ordered-timeline folding. Encodes the rules that
 * matter for trust: items keep ARRIVAL ORDER (tool chips interleave with
 * prose exactly where they happened), results attach to the RIGHT step, and
 * an error frame is sticky (a later done{ok} cannot un-fail a run the user
 * saw fail).
 */

import { describe, it, expect } from "vitest"
import {
  assistantTextOf,
  createRun,
  proposalsOf,
  reduceRunFrame,
  failRun,
  markMemoryReviewed,
  markBriefReviewed,
} from "./run-state"
import type { AgentFrame } from "./protocol"

function fold(frames: AgentFrame[]) {
  return frames.reduce(reduceRunFrame, createRun("prompt"))
}

describe("reduceRunFrame", () => {
  it("keeps prose and tool calls in arrival order", () => {
    const run = fold([
      { type: "run_start", runId: "r1" },
      { type: "assistant_delta", text: "Let me look. " },
      { type: "code_start", step: 1, kind: "sql", summary: "SELECT 1" },
      { type: "code_result", step: 1, ok: true, summary: "1 row" },
      { type: "assistant_delta", text: "Found " },
      { type: "assistant_delta", text: "it." },
      { type: "done", runId: "r1", status: "ok" },
    ])
    expect(run.runId).toBe("r1")
    expect(run.items.map((i) => i.kind)).toEqual(["text", "tool", "text"])
    expect(run.items[0]).toMatchObject({ kind: "text", text: "Let me look. " })
    expect(run.items[1]).toMatchObject({ kind: "tool", step: 1, ok: true, resultSummary: "1 row" })
    expect(run.items[2]).toMatchObject({ kind: "text", text: "Found it." })
    expect(run.status).toBe("ok")
  })

  it("pairs code_result with its step and leaves unresolved steps running", () => {
    const run = fold([
      { type: "code_start", step: 1, kind: "sql", summary: "SELECT 1" },
      { type: "code_start", step: 2, kind: "docs", summary: "drafting" },
      { type: "code_result", step: 1, ok: false, summary: "syntax error" },
      { type: "done", runId: "r1", status: "capped" },
    ])
    expect(run.items).toHaveLength(2)
    expect(run.items[0]).toMatchObject({ kind: "tool", step: 1, ok: false, resultSummary: "syntax error" })
    expect(run.items[1]).toMatchObject({ kind: "tool", step: 2 })
    expect((run.items[1] as { ok?: boolean }).ok).toBeUndefined() // step 2 result never arrived
    expect(run.status).toBe("capped")
  })

  it("attaches typed code_result data for rich rendering", () => {
    const run = fold([
      { type: "code_start", step: 1, kind: "read", summary: "MRK 4 · untranslated" },
      {
        type: "code_result",
        step: 1,
        ok: true,
        summary: "2 cells",
        data: { cells: [{ cellId: "c1", ref: "MRK 4:1", source: "Καὶ", target: "", status: "untranslated" }] },
      },
    ])
    expect(run.items[0]).toMatchObject({
      kind: "tool",
      tool: "read",
      data: { cells: [{ cellId: "c1", ref: "MRK 4:1" }] },
    })
  })

  it("places proposals in the timeline where they arrived and exposes them via proposalsOf", () => {
    const proposal = { proposalId: "p1", runId: "r1", events: [], summary: "Draft 2 cells" }
    const run = fold([
      { type: "assistant_delta", text: "Drafting…" },
      { type: "proposal", proposal },
      { type: "assistant_delta", text: "Done — review below." },
      { type: "usage", promptTokens: 10, completionTokens: 5, costCredits: 1 },
    ])
    expect(run.items.map((i) => i.kind)).toEqual(["text", "proposal", "text"])
    expect(proposalsOf(run)).toEqual([proposal])
    expect(run.usage).toEqual({ promptTokens: 10, completionTokens: 5, costCredits: 1 })
  })

  it("assistantTextOf joins prose segments for prior-turn wire content", () => {
    const run = fold([
      { type: "assistant_delta", text: "First." },
      { type: "code_start", step: 1, kind: "sql", summary: "SELECT 1" },
      { type: "assistant_delta", text: "Second." },
    ])
    expect(assistantTextOf(run)).toBe("First.\n\nSecond.")
  })

  it("tracks progress frames and clears progress when the run settles", () => {
    const mid = fold([{ type: "progress", label: "Drafting MRK 4", done: 3, total: 12 }])
    expect(mid.progress).toEqual({ label: "Drafting MRK 4", done: 3, total: 12 })
    const done = reduceRunFrame(mid, { type: "done", runId: "r1", status: "ok" })
    expect(done.progress).toBeUndefined()
  })

  it("an error frame is sticky across a later done frame", () => {
    const run = fold([
      { type: "error", message: "model refused" },
      { type: "done", runId: "r1", status: "ok" },
    ])
    expect(run.status).toBe("error")
    expect(run.errorMessage).toBe("model refused")
  })

  it("failRun never overwrites an existing error", () => {
    const errored = fold([{ type: "error", message: "real cause" }])
    expect(failRun(errored, "stream closed").errorMessage).toBe("real cause")
    expect(failRun(createRun("p"), "network down")).toMatchObject({
      status: "error",
      errorMessage: "network down",
    })
  })
})

// ── AQU-AGENT wave-1 frames (docs/swarm/AQU-AGENT-CONTRACTS.md §4) ─────────
describe("reduceRunFrame — AQU-AGENT additions", () => {
  it("opens a code-activity item on tool.code.start and pairs the matching tool.code.output", () => {
    const run = fold([
      { type: "tool.code.start", runId: "r1", language: "python", codePreview: "print(1)" },
      { type: "tool.code.output", runId: "r1", stdout: "1\n", stderr: "", truncated: false, durationMs: 42 },
    ])
    expect(run.items).toHaveLength(1)
    expect(run.items[0]).toMatchObject({
      kind: "code",
      language: "python",
      codePreview: "print(1)",
      stdout: "1\n",
      stderr: "",
      truncated: false,
      durationMs: 42,
    })
  })

  it("leaves a code item without output when tool.code.output never arrives (still running)", () => {
    const run = fold([{ type: "tool.code.start", runId: "r1", language: "js", codePreview: "1+1" }])
    expect(run.items[0]).toMatchObject({ kind: "code" })
    expect((run.items[0] as { durationMs?: number }).durationMs).toBeUndefined()
  })

  it("pairs tool.code.output with the most recently opened unpaired code item (no step counter)", () => {
    const run = fold([
      { type: "tool.code.start", runId: "r1", language: "js", codePreview: "first()" },
      { type: "tool.code.output", runId: "r1", stdout: "a", stderr: "", truncated: false, durationMs: 10 },
      { type: "tool.code.start", runId: "r1", language: "js", codePreview: "second()" },
      { type: "tool.code.output", runId: "r1", stdout: "b", stderr: "", truncated: false, durationMs: 20 },
    ])
    expect(run.items).toHaveLength(2)
    expect(run.items[0]).toMatchObject({ codePreview: "first()", stdout: "a", durationMs: 10 })
    expect(run.items[1]).toMatchObject({ codePreview: "second()", stdout: "b", durationMs: 20 })
  })

  it("stages a changeset.staged frame as a reviewable card in the timeline", () => {
    const run = fold([
      {
        type: "changeset.staged",
        runId: "r1",
        changesetId: "cs-1",
        approvalUrl: "https://app.example/approve/cs-1",
        summary: "Import glossary.csv",
        cellCount: 40,
      },
    ])
    expect(run.items[0]).toMatchObject({
      kind: "changeset",
      changesetId: "cs-1",
      approvalUrl: "https://app.example/approve/cs-1",
      summary: "Import glossary.csv",
      cellCount: 40,
    })
  })

  it("records memory.proposed and brief.proposed as inline notices, pending by default", () => {
    const run = fold([
      { type: "memory.proposed", runId: "r1", memoryId: "m1", path: "observations/mrk.md", preview: "MRK terms…" },
      { type: "brief.proposed", runId: "r1", proposalId: "b1", preview: "Update tone guidance" },
    ])
    expect(run.items.map((i) => i.kind)).toEqual(["memory-proposed", "brief-proposed"])
    expect(run.items[0]).toMatchObject({ memoryId: "m1", path: "observations/mrk.md", status: "pending" })
    expect(run.items[1]).toMatchObject({ proposalId: "b1", preview: "Update tone guidance", status: "pending" })
  })

  it("markMemoryReviewed flips only the matching memory-proposed item (mem-M5)", () => {
    const run = fold([
      { type: "memory.proposed", runId: "r1", memoryId: "m1", path: "a.md", preview: "a" },
      { type: "memory.proposed", runId: "r1", memoryId: "m2", path: "b.md", preview: "b" },
    ])
    const reviewed = markMemoryReviewed(run, "m1")
    expect(reviewed.items[0]).toMatchObject({ memoryId: "m1", status: "reviewed" })
    expect(reviewed.items[1]).toMatchObject({ memoryId: "m2", status: "pending" })
  })

  it("markBriefReviewed flips only the matching brief-proposed item (mem-M5)", () => {
    const run = fold([{ type: "brief.proposed", runId: "r1", proposalId: "b1", preview: "x" }])
    const reviewed = markBriefReviewed(run, "b1")
    expect(reviewed.items[0]).toMatchObject({ proposalId: "b1", status: "reviewed" })
    expect(markBriefReviewed(run, "nope").items[0]).toMatchObject({ status: "pending" })
  })

  it("tracks the budget meter across budget frames, and marks it exhausted on budget.exhausted", () => {
    const running = fold([{ type: "budget", runId: "r1", spentCredits: 120, capCredits: 500 }])
    expect(running.budget).toEqual({ spentCredits: 120, capCredits: 500, exhausted: false })

    const halted = reduceRunFrame(running, {
      type: "budget.exhausted",
      runId: "r1",
      spentCredits: 500,
      capCredits: 500,
    })
    expect(halted.budget).toEqual({ spentCredits: 500, capCredits: 500, exhausted: true })
  })
})
