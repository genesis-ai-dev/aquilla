/**
 * run-state tests — frame → UI-state folding. Encodes the two rules that
 * matter for trust: results attach to the RIGHT step, and an error frame is
 * sticky (a later done{ok} cannot un-fail a run the user saw fail).
 */

import { describe, it, expect } from "vitest"
import { createRun, reduceRunFrame, failRun } from "./run-state"
import type { AgentFrame } from "./protocol"

function fold(frames: AgentFrame[]) {
  return frames.reduce(reduceRunFrame, createRun("prompt"))
}

describe("reduceRunFrame", () => {
  it("accumulates assistant deltas and pairs code_result with its step", () => {
    const run = fold([
      { type: "run_start", runId: "r1" },
      { type: "assistant_delta", text: "Hello " },
      { type: "assistant_delta", text: "world" },
      { type: "code_start", step: 1, kind: "sql", summary: "SELECT 1" },
      { type: "code_start", step: 2, kind: "docs", summary: "drafting" },
      { type: "code_result", step: 1, ok: false, summary: "syntax error" },
      { type: "done", runId: "r1", status: "capped" },
    ])
    expect(run.runId).toBe("r1")
    expect(run.assistantText).toBe("Hello world")
    expect(run.steps).toHaveLength(2)
    expect(run.steps[0]).toMatchObject({ step: 1, ok: false, resultSummary: "syntax error" })
    expect(run.steps[1].ok).toBeUndefined() // step 2 result never arrived
    expect(run.status).toBe("capped")
  })

  it("collects proposals and usage", () => {
    const proposal = { proposalId: "p1", runId: "r1", events: [], summary: "Draft 2 cells" }
    const run = fold([
      { type: "proposal", proposal },
      { type: "usage", promptTokens: 10, completionTokens: 5, costCents: 0.1 },
    ])
    expect(run.proposals).toEqual([proposal])
    expect(run.usage).toEqual({ promptTokens: 10, completionTokens: 5, costCents: 0.1 })
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
