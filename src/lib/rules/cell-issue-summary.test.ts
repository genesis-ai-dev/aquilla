import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { translate } from "@/lib/i18n/translate"
import { en } from "@/lib/i18n/messages/en"
import { DEFAULT_LOCALE } from "@/lib/i18n/locales"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"
import type { TranslationRule } from "@/lib/parsers/types"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { formatCellIssueLine, summarizeCellIssues } from "./cell-issue-summary"

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate(en, key, vars, DEFAULT_LOCALE)

function cell(original: string, translated: string): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original,
    translated,
    context: "",
    group: "g",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

const USER_RULE: TranslationRule = {
  id: "user:no-foo",
  name: "No foo",
  description: "Do not write foo",
  severity: "minor",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "\\bfoo\\b" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

describe("summarizeCellIssues", () => {
  it("names a real number-integrity infraction without repeating the check name", () => {
    const rules = resolveBuiltinRules(undefined)
    const infractions = checkRulesForCell(
      cell("Isaiah 40:25.", "Isaias"),
      "file-1",
      rules,
    )
    const byId = new Map(rules.map((rule) => [rule.id, rule]))
    const lines = summarizeCellIssues(infractions, byId, t)

    const number = lines.find((line) => line.ruleId === "builtin:number-integrity")
    const end = lines.find((line) => line.ruleId === "builtin:end-punctuation-mismatch")
    expect(number).toEqual({
      ruleId: "builtin:number-integrity",
      name: "Number integrity",
      reason: "Number from source missing in translation",
    })
    expect(end).toEqual({
      ruleId: "builtin:end-punctuation-mismatch",
      name: "End punctuation",
      reason: "Terminal punctuation differs from source",
    })
    expect(formatCellIssueLine(number!)).toBe(
      "Number integrity — Number from source missing in translation",
    )
    expect(formatCellIssueLine(number!)).not.toContain("Number integrity — Number integrity")
  })

  it("uses a user rule's own name for the same hover line", () => {
    const infractions = checkRulesForCell(
      cell("Hello.", "foo"),
      "file-1",
      [USER_RULE],
    )
    const lines = summarizeCellIssues(
      infractions,
      new Map([[USER_RULE.id, USER_RULE]]),
      t,
    )
    expect(lines).toEqual([
      {
        ruleId: "user:no-foo",
        name: "No foo",
        reason: "target contains forbidden pattern",
      },
    ])
  })
})
