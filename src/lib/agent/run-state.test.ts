/**
 * run-state tests — frame → ordered-timeline folding. Encodes the rules that
 * matter for trust: items keep ARRIVAL ORDER (tool chips interleave with
 * prose exactly where they happened), results attach to the RIGHT step, and
 * an error frame is sticky (a later done{ok} cannot un-fail a run the user
 * saw fail).
 */

import { describe, it, expect } from "vitest"
import { assistantTextOf, createRun, proposalsOf, reduceRunFrame, failRun } from "./run-state"
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
      { type: "usage", promptTokens: 10, completionTokens: 5, costCents: 0.1 },
    ])
    expect(run.items.map((i) => i.kind)).toEqual(["text", "proposal", "text"])
    expect(proposalsOf(run)).toEqual([proposal])
    expect(run.usage).toEqual({ promptTokens: 10, completionTokens: 5, costCents: 0.1 })
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
