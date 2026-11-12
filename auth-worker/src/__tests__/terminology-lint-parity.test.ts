// AQU-1711: autopilot's half of the terminology verdict table. Its flags route
// spans to the full verifier panel and drive the redraft loop, so they must be
// the violations the person sees in the editor. Root Vitest runs the same rows
// through compileConceptsToRules + checkRulesForCell. Every verdict here is
// the editor's, except a row that names the ticket closing a known gap.

import { describe, it, expect } from "vitest"
import { lintTerminology, type Concept } from "../lib/contextual/project-context"
import { TERMINOLOGY_LINT_PARITY_CASES } from "../../../src/lib/terminology/__fixtures__/terminology-lint-parity"

describe("lintTerminology", () => {
  it.each(TERMINOLOGY_LINT_PARITY_CASES)(
    "flags what the editor flags — $name",
    ({ concepts, termMatching, source, target, editor, server }) => {
      const hits = lintTerminology(concepts, source, target, termMatching)
      expect(hits.map((h) => h.ruleId)).toEqual(server?.flagged ?? editor)
    },
  )

  it("tells the model the term, its renderings and both counts, never the regex", () => {
    const grace: Concept = {
      id: "grace",
      sourceTerm: "grace",
      renderings: [{ rendering: "gracia", status: "preferred" }],
      status: "active",
    }
    const [missing] = lintTerminology([grace], "by grace", "por favor")
    expect(missing).toMatchObject({ ruleId: "term:grace:approved", ruleName: "Term: grace" })
    expect(missing.message).toBe(`"grace" must use an approved rendering (gracia)`)

    const [tooFew] = lintTerminology([grace], "grace upon grace", "gracia sobre favor")
    expect(tooFew.message).toContain("×2 in the source, ×1 in the target")
    expect(tooFew.message).not.toMatch(/\\p\{|\(\?<!/)
  })
})
