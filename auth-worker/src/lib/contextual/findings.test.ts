// findings — what a human reviewer should know about a cell the pipeline
// accepted (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md §1).
// Accepted is not the same as unanimous: these codes are the difference, and
// they used to be thrown away at staging.

import { describe, expect, it } from "vitest"
import { cellFindings } from "./findings"
import type { LintFlag, Vote } from "./types"

const vote = (verifier: Vote["verifier"], approve: boolean, cellVerdicts: Vote["cellVerdicts"] = []): Vote => ({
  spanId: "s",
  verifier,
  approve,
  cellVerdicts,
  reason: approve ? "" : "prose that must never be stored",
})
const flag = (cellId: string, ruleId: string): LintFlag => ({ spanId: "s", cellId, ruleId, message: "m" })

describe("cellFindings", () => {
  it("is empty for a cell every verifier approved with no flags", () => {
    expect(cellFindings("c1", { votes: [vote("force", true), vote("naturalness", true)], flags: [], redrafted: false })).toEqual([])
  })

  it("records a dissenting verifier the quorum outvoted — by code, never its prose", () => {
    const out = cellFindings("c1", {
      votes: [vote("force", true), vote("naturalness", true, [{ cellId: "c1", approve: false, reason: "clunky" }])],
      flags: [],
      redrafted: false,
    })
    expect(out).toEqual(["dissent:naturalness"])
    expect(out.join()).not.toContain("clunky")
  })

  it("uses a verifier's span-level no when it gave no per-cell verdict", () => {
    expect(cellFindings("c1", { votes: [vote("force", false)], flags: [], redrafted: false })).toEqual(["dissent:force"])
  })

  it("never lists an ambiguity no: that is a veto, so such a cell is never staged", () => {
    expect(cellFindings("c1", { votes: [vote("ambiguity", false)], flags: [], redrafted: false })).toEqual([])
  })

  it("adds this cell's lint rules, unsupported wording, and a redraft, in a stable order", () => {
    const out = cellFindings("c1", {
      votes: [],
      flags: [flag("c1", "term-x"), flag("c2", "other-cell"), flag("c1", "term-x")],
      support: { applicable: true, ratio: 0.5, riskyCellIds: ["c1"] },
      redrafted: true,
    })
    expect(out).toEqual(["lint:term-x", "unsupported", "redrafted"])
  })
})
