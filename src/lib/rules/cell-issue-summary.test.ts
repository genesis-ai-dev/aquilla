import { describe, it, expect } from "vitest"
import { summarizeCellIssues, infractionReason } from "./cell-issue-summary"
import { checkRulesForCell } from "./rule-engine"
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"
import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    original: "test", translated: "", fileId: "test-file", context: "", group: "", type: "text",
    originalHtml: undefined, status: "empty", validationStatus: "none", activeValidators: [],
    validationHistory: [], history: [], threads: [],
    ...overrides,
  }
}

function builtinRule(checkId: keyof typeof BUILTIN_CHECKS): TranslationRule {
  const def = BUILTIN_CHECKS[checkId]
  return {
    id: `builtin:${checkId}`, name: def.name, description: def.description,
    severity: def.defaultSeverity, source: "algorithmic", scope: "project", enabled: true,
    createdAt: new Date().toISOString(), check: { type: "builtin", checkId },
  }
}

describe("infractionReason", () => {
  it("strips the leading `\"<name>\": ` prefix rule-engine prepends", () => {
    expect(infractionReason('"Number integrity": Number from source missing in translation', "Number integrity"))
      .toBe("Number from source missing in translation")
  })

  it("passes a message through unchanged when it lacks the name prefix", () => {
    expect(infractionReason("Something else", "Number integrity")).toBe("Something else")
  })
})

describe("summarizeCellIssues", () => {
  it("maps each infraction to its rule name and a reason", () => {
    const infractions: RuleInfraction[] = [
      { ruleId: "r1", cellId: "c1", fileId: "f1", message: '"No slang": target contains forbidden pattern', spans: [] },
    ]
    const lines = summarizeCellIssues(infractions, (id) => (id === "r1" ? "No slang" : undefined))
    expect(lines).toEqual([{ ruleId: "r1", name: "No slang", reason: "target contains forbidden pattern" }])
  })

  it("falls back to the ruleId when the name cannot be resolved", () => {
    const infractions: RuleInfraction[] = [
      { ruleId: "orphan", cellId: "c1", fileId: "f1", message: "boom", spans: [] },
    ]
    const lines = summarizeCellIssues(infractions, () => undefined)
    expect(lines[0]).toEqual({ ruleId: "orphan", name: "orphan", reason: "boom" })
  })

  // AQU-757: the escaped bug was that a flagged cell explained nothing on hover.
  // Guard the full producer→consumer path: a real built-in integrity check
  // (number-integrity) fires through the rule engine, and its infraction must
  // surface as the check NAME plus a plain-language reason with no duplicated
  // name prefix — exactly what the cell-number hover tooltip renders.
  it("turns a real number-integrity infraction into a name + plain-language reason", () => {
    const rule = builtinRule("number-integrity")
    const cell = makeCell({
      id: "c1", original: "Chapter 5 begins", translated: "Le chapitre commence", status: "unvalidated",
    })
    const infractions = checkRulesForCell(cell, "f1", [rule])
    expect(infractions).toHaveLength(1)

    const lines = summarizeCellIssues(infractions, (id) => (id === rule.id ? rule.name : undefined))
    expect(lines).toEqual([
      { ruleId: rule.id, name: "Number integrity", reason: "Number from source missing in translation" },
    ])
    // The reason must not re-embed the check name the tooltip already shows.
    expect(lines[0].reason).not.toContain("Number integrity")
  })

  it("covers all validator types, not just number/punctuation integrity", () => {
    const rules = [builtinRule("end-punctuation-mismatch"), builtinRule("double-space")]
    const cell = makeCell({
      id: "c1", original: "Hello world.", translated: "Bonjour  le monde", status: "unvalidated",
    })
    const infractions = checkRulesForCell(cell, "f1", rules)
    const lines = summarizeCellIssues(infractions, (id) => rules.find((r) => r.id === id)?.name)
    const names = lines.map((l) => l.name)
    expect(names).toContain("End punctuation")
    expect(names).toContain("Extra whitespace")
    for (const line of lines) expect(line.reason.length).toBeGreaterThan(0)
  })
})
