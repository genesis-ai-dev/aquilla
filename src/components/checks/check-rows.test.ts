import { describe, expect, it } from "vitest"
import type { TranslationRule } from "@/lib/parsers/types"
import type { RuleApplicability, StyleRule } from "@/lib/rules/style-rule-types"
import { buildCheckRows, countCheckRows, styleRuleChips } from "./check-rows"

function rule(id: string, extra: Partial<TranslationRule> = {}): TranslationRule {
  return {
    id,
    name: id,
    description: "",
    severity: "minor",
    source: "user",
    scope: "project",
    check: { type: "target-forbids", targetPattern: "x" },
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    ...extra,
  }
}

function builtin(id: string, checkId: string): TranslationRule {
  return rule(id, {
    source: "algorithmic",
    check: { type: "builtin", checkId } as TranslationRule["check"],
  })
}

function style(id: string, extra: Partial<StyleRule> = {}): StyleRule {
  return {
    id,
    orgId: null,
    projectId: "p1",
    instruction: id,
    category: "style",
    scope: "global",
    conditions: null,
    examples: null,
    exceptions: null,
    source: null,
    checkSpec: null,
    severity: "minor",
    enabled: true,
    status: "approved",
    humanEdited: false,
    provenance: null,
    createdBy: null,
    reviewedBy: null,
    version: 1,
    createdAt: "",
    updatedAt: "",
    ...extra,
  }
}

function applies(ruleId: string, targetType: RuleApplicability["targetType"], targetId: string, relationship: RuleApplicability["relationship"] = "applies"): RuleApplicability {
  return {
    id: `${ruleId}-${targetId}`,
    ruleId,
    targetType,
    targetId,
    relationship,
    confidence: null,
    reason: null,
    assignedBy: "human",
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  }
}

describe("buildCheckRows", () => {
  it("puts every store in one list, most specific scope first", () => {
    const rows = buildCheckRows({
      userRules: [rule("everywhere"), rule("french", { scope: "lane", lane: "fr" })],
      orgRules: [rule("org-rule", { scope: "org" })],
      builtinRules: [builtin("empty", "empty-target")],
      styleRules: [style("psalms"), style("global-style")],
      styleApplicability: [applies("psalms", "book", "PSA")],
      viewLane: "fr",
      multiLane: true,
    })
    expect(rows.map((r) => r.key)).toEqual([
      "project:french",
      "style:psalms",
      "project:everywhere",
      "style:global-style",
      "org:org-rule",
      "builtin:empty",
    ])
    expect(countCheckRows(rows)).toEqual({ project: 2, org: 1, style: 2, builtin: 1 })
  })

  it("hides other lanes' rules unless asked, and then lists them last", () => {
    const input = {
      userRules: [rule("spanish", { scope: "lane" as const, lane: "es" }), rule("all")],
      builtinRules: [builtin("empty", "empty-target")],
      viewLane: "fr",
      multiLane: true,
    }
    expect(buildCheckRows(input).map((r) => r.key)).toEqual(["project:all", "builtin:empty"])
    const shown = buildCheckRows({ ...input, showOtherLanes: true })
    expect(shown.map((r) => r.key)).toEqual(["project:all", "builtin:empty", "project:spanish"])
    expect(shown[2].chips).toEqual([{ kind: "lane", relation: "other", lane: "es" }])
  })

  it("labels project rules plainly on a single-lane project", () => {
    const [row] = buildCheckRows({ userRules: [rule("a")], viewLane: "", multiLane: false })
    expect(row.chips).toEqual([{ kind: "project" }])
  })

  it("leaves proposed style rules for review, not the list", () => {
    const rows = buildCheckRows({
      userRules: [],
      styleRules: [style("draft", { status: "proposed" }), style("ok")],
      viewLane: "",
      multiLane: false,
    })
    expect(rows.map((r) => r.key)).toEqual(["style:ok"])
  })
})

describe("styleRuleChips", () => {
  it("names each target the rule applies to, skipping exclusions", () => {
    const chips = styleRuleChips(style("r", { scope: "genre" }), [
      applies("r", "genre", "poetry"),
      applies("r", "book", "PRO", "excluded"),
      applies("other", "book", "GEN"),
    ])
    expect(chips).toEqual([{ kind: "target", targetType: "genre", targetId: "poetry" }])
  })

  it("falls back to the rule's own scope when nothing is assigned", () => {
    expect(styleRuleChips(style("r", { scope: "document" }))).toEqual([{ kind: "styleScope", scope: "document" }])
    expect(styleRuleChips(style("r"))).toEqual([{ kind: "project" }])
  })
})
