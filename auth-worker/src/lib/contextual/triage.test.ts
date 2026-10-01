// triage — which findings a reviewer must look at, stored with the draft
// (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md §2). The Files
// changed and Checks views lead with `_triage: human`; staging must never wait
// on, or fail because of, this judgement.

import { describe, expect, it } from "vitest"
import { fallbackTriage, triageVerdicts, type TriageCell } from "./triage"
import type { DecideResult } from "../jev/decide"

const cell = (cellId: string, findings: string[]): TriageCell => ({ cellId, ref: "MRK 1:1", source: "s", text: "t", findings })

describe("fallbackTriage", () => {
  it.each([
    [["unsupported"], "human", 3],
    [["dissent:naturalness"], "human", 3],
    [["lint:term-x"], "advisory", 2],
    [["redrafted"], "advisory", 1],
    [["lint:term-x", "unsupported"], "human", 3],
  ])("%o → %s, severity %d", (findings, triage, severity) => {
    expect(fallbackTriage(findings)).toEqual({ triage, severity })
  })
})

describe("triageVerdicts", () => {
  const decideWith = (answers: DecideResult["answers"], decidedBy: DecideResult["decidedBy"] = "model") =>
    async () => ({ answers, decidedBy, model: "m", usage: null }) as DecideResult

  it("stores codes plus Jev's per-cell call, and who made it", async () => {
    const out = await triageVerdicts([cell("a", ["lint:term-x"])], decideWith({
      c0_needs_human: { kind: "noul", p: 0.8 },
      c0_severity: { kind: "score", score: 3.4 },
    }))
    expect(out.get("a")).toEqual({ "lint:term-x": "flag", _triage: "human", _severity: "3", _decidedBy: "model" })
  })

  it("asks nothing about cells with no findings — they stage with empty verdicts", async () => {
    let asked = false
    const out = await triageVerdicts([cell("a", [])], async () => { asked = true; throw new Error("no") })
    expect(asked).toBe(false)
    expect(out.get("a")).toEqual({})
  })

  it("never fails staging: a throwing judge falls back per cell", async () => {
    const out = await triageVerdicts([cell("a", ["unsupported"])], async () => { throw new Error("down") })
    expect(out.get("a")).toMatchObject({ unsupported: "flag", _triage: "human", _severity: "3", _decidedBy: "heuristic" })
  })
})
