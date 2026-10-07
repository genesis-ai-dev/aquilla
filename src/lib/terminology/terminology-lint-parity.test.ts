// AQU-1711: the editor's half of the terminology verdict table. auth-worker's
// terminology-lint-parity.test.ts runs the same rows through autopilot's
// lintTerminology, so autopilot is told about the term violations the person
// sees in the editor, and only those.

import { describe, it, expect } from "vitest"
import { compileConceptsToRules } from "./compile"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import type { CellData } from "@/hooks/useCells"
import { TERMINOLOGY_LINT_PARITY_CASES } from "./__fixtures__/terminology-lint-parity"

function cell(original: string, translated: string): CellData {
  return {
    id: "c1", original, translated, fileId: "f1", context: "", group: "", type: "text",
    originalHtml: undefined, status: "unvalidated", validationStatus: "none", activeValidators: [],
    validationHistory: [], history: [], threads: [],
  }
}

describe("compileConceptsToRules + checkRulesForCell — verdicts autopilot's lint must match", () => {
  it.each(TERMINOLOGY_LINT_PARITY_CASES)("$name", ({ concepts, termMatching, source, target, editor }) => {
    const rules = compileConceptsToRules(concepts, termMatching)
    expect(checkRulesForCell(cell(source, target), "f1", rules).map((i) => i.ruleId)).toEqual(editor)
  })
})
