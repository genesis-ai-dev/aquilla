// lint.ts — the agent's self-correction loop. WHY: the client's proposal-card
// lint shows violations to the USER; this lint puts them in the verdict block
// so the MODEL fixes its own drafts before a human reads them (the essay's
// "#REF! in row 57" move). The two must judge a draft the same way, or the
// agent rewrites lines the person sees as fine and leaves lines the person
// sees as broken (AQU-1705). So every verdict here is the editor's, from the
// table that rule-engine.test.ts also runs.

import { describe, it, expect } from "vitest"
import { lintDraft, type LintRule } from "../lib/agent/lint"
import { RULE_LINT_PARITY_CASES } from "../../../src/lib/rules/__fixtures__/rule-lint-parity"

describe("lintDraft", () => {
  it.each(RULE_LINT_PARITY_CASES)("flags what the editor flags — $name", ({ ruleId, check, source, target, flagged }) => {
    const rule: LintRule = { id: ruleId, name: ruleId, enabled: true, check }
    expect(lintDraft([rule], source, target).map((h) => h.ruleId)).toEqual(flagged ? [ruleId] : [])
  })

  it("tells the model both counts, so it knows whether to add or remove a rendering", () => {
    const rule: LintRule = {
      id: "r-grace",
      name: "Render 'grace' as 'gracia'",
      enabled: true,
      check: { type: "source-requires-target", sourcePattern: "grace", targetPattern: "gracia" },
    }
    const [tooFew] = lintDraft([rule], "grace upon grace", "gracia sobre favor")
    expect(tooFew).toMatchObject({ ruleId: "r-grace", ruleName: "Render 'grace' as 'gracia'" })
    expect(tooFew.message).toContain(`"grace" ×2 in the source, "gracia" ×1 in the target`)

    const [tooMany] = lintDraft([rule], "by grace", "por gracia y gracia")
    expect(tooMany.message).toContain(`"grace" ×1 in the source, "gracia" ×2 in the target`)
  })
})

describe("rule pattern ReDoS guard", () => {
  it("skips catastrophic nested-quantifier patterns instead of running them", () => {
    const rule: LintRule = {
      id: "r-redos",
      name: "redos",
      enabled: true,
      check: { type: "target-forbids", targetPattern: "(a+)+$" },
    }
    const t0 = Date.now()
    expect(lintDraft([rule], "src", "a".repeat(40) + "!")).toEqual([])
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
