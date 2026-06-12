// lint.ts — the agent's self-correction loop. WHY: the client's proposal-card
// lint shows violations to the USER; this lint puts them in the verdict block
// so the MODEL fixes its own drafts before a human reads them (the essay's
// "#REF! in row 57" move). Term-regex semantics must stay in lockstep with
// src/lib/terminology/match.ts.

import { describe, it, expect } from "vitest"
import { lintDraft, type LintRule } from "../lib/agent/lint"

const rules: LintRule[] = [
  {
    id: "r-forbid",
    name: "No anglicism",
    enabled: true,
    check: { type: "target-forbids", targetPattern: "baptize*" },
  },
  {
    id: "r-require",
    name: "Render 'grace' as 'gracia'",
    enabled: true,
    check: { type: "source-requires-target", sourcePattern: "grace", targetPattern: "gracia*" },
  },
]

describe("lintDraft", () => {
  it("flags a forbidden term, inflections included (wildcard = \\p{L}*)", () => {
    const hits = lintDraft(rules, "John baptized them", "Juan los baptizeó")
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ruleId: "r-forbid", ruleName: "No anglicism" })
  })

  it("flags a missing required rendering only when the source triggers it", () => {
    const triggered = lintDraft(rules, "by grace you are saved", "por fe sois salvos")
    expect(triggered.map((h) => h.ruleId)).toEqual(["r-require"])

    const satisfied = lintDraft(rules, "by grace you are saved", "por gracias sois salvos")
    expect(satisfied).toHaveLength(0)

    const untriggered = lintDraft(rules, "by faith you are saved", "por fe sois salvos")
    expect(untriggered).toHaveLength(0)
  })

  it("matches whole words only — 'grace' does not fire inside 'disgraceful'", () => {
    const hits = lintDraft(rules, "a disgraceful act", "un acto vergonzoso")
    expect(hits).toHaveLength(0)
  })

  it("never throws on malformed user patterns or empty drafts", () => {
    const bad: LintRule[] = [
      { id: "b", name: "bad", enabled: true, check: { type: "target-forbids", targetPattern: "([" } },
    ]
    expect(lintDraft(bad, "src", "tgt")).toEqual([])
    expect(lintDraft(rules, "by grace", "")).toEqual([])
  })
})
