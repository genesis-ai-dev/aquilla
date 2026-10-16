// AQU-1676 — conjunction: does the target's connective reverse the source's
// relation? Fixture: John 3:17. The Greek opens with γάρ ("For God did not send
// His Son…"), giving the reason for 3:16. A draft that opens "So God did not
// send…" turns the reason into a result.
//
// The eval decided the rule: weak source relations (καί / narrative δέ) are
// rendered "When", "So", "But" all the time in good translation, so only
// REVERSALS are findings.

import { describe, expect, it } from "vitest"
import { connectiveCheck, CONTRADICTS } from "./connectives"
import { CHECKS } from "./runner"
import type { HarmonizerCell } from "./types"

const JOHN_3: HarmonizerCell[] = [
  { id: "JHN 3:16", ref: "JHN 3:16", source: "οὕτως γὰρ ἠγάπησεν ὁ θεὸς τὸν κόσμον…", target: "For God so loved the world that He gave His one and only Son…" },
  { id: "JHN 3:17", ref: "JHN 3:17", source: "οὐ γὰρ ἀπέστειλεν ὁ θεὸς τὸν υἱὸν εἰς τὸν κόσμον…", target: "So God did not send His Son into the world to condemn the world…" },
]

const ask = (answers: Record<string, unknown>) =>
  connectiveCheck.findings(connectiveCheck.plan(JOHN_3)!, JOHN_3, answers, "p_")

const rel = (choice: string, p = 0.9) => ({ choice, probabilities: { [choice]: p } })

describe("connectiveCheck", () => {
  it("JHN 3:17: flags 'So' where the Greek γάρ gives a reason", () => {
    expect(ask({ p_c0_source: rel("reason"), p_c0_target: rel("inference"), p_c0_word: rel("w0", 0.9) })).toEqual([
      expect.objectContaining({
        cellId: "JHN 3:17", old: "So", start: 0, end: 2, flagOnly: true,
        reasonKey: "harmonizer.connective.reason", reasonValues: { previous: "JHN 3:16" },
      }),
    ])
  })

  it("never flags a weak source relation rendered freely ('So', 'When' for καί)", () => {
    expect(ask({ p_c0_source: rel("addition"), p_c0_target: rel("inference") })).toEqual([])
    expect(ask({ p_c0_source: rel("addition"), p_c0_target: rel("time") })).toEqual([])
  })

  it("never flags a connective left out — dropping 'for' is often right", () => {
    expect(ask({ p_c0_source: rel("reason"), p_c0_target: rel("none") })).toEqual([])
  })

  it("needs both sides confident", () => {
    expect(ask({ p_c0_source: rel("reason", 0.55), p_c0_target: rel("inference") })).toEqual([])
  })

  it("only reversals are contradictions", () => {
    expect([...CONTRADICTS].sort()).toEqual(["contrast~inference", "inference~reason", "reason~inference"])
  })

  it("is registered — it passed the eval", () => {
    expect(CHECKS.map((c) => c.id)).toContain("textual.connective")
  })
})
