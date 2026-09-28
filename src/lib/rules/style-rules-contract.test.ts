/**
 * Producer → consumer contract (AGENTS.md rule 12) for the AQU-934 pipeline:
 *
 *   extraction candidate → proposed rule → approved library rule
 *     → applicability resolution for a real cell → prompt block
 *
 * Each stage here consumes the PREVIOUS stage's actual output, so a shape drift
 * between the extractor, the resolver, and the prompt builder fails here even
 * when every module's own unit tests still pass.
 */
import { describe, expect, it } from "vitest"

import { buildStyleRulesBlock } from "@/lib/completion/completion-service"
import { bookGenre } from "@/lib/scripture/book-genres"

import { buildApplicabilityIndex, cellCoordinates, resolveEffectiveRules } from "./applicability"
import { compileStyleRulesToTranslationRules } from "./style-rule-bridge"
import { parseStyleRuleCandidates } from "./style-rule-extractor"
import type { RuleApplicability, StyleRule, StyleRuleCandidate } from "./style-rule-types"

/** The shape the extractor actually emits from a model response. */
const MODEL_RESPONSE = JSON.stringify([
  { instruction: "Keep parallel lines on separate lines.", category: "formatting", scopeHint: "genre:poetry" },
  { instruction: "Use the covenant name in small caps.", category: "terminology", scopeHint: "global" },
  { instruction: "Prefer short sentences in narrative.", category: "style", scopeHint: "genre:gospel" },
])

/** Promote a candidate exactly as the review UI does once a human approves it. */
function approve(candidate: StyleRuleCandidate, id: string): StyleRule {
  const scopeHint = candidate.scopeHint
  return {
    id,
    orgId: null,
    projectId: "p1",
    instruction: candidate.instruction,
    category: candidate.category,
    scope: scopeHint === "global" ? "global" : "genre",
    conditions: candidate.conditions ?? null,
    examples: candidate.examples ?? null,
    exceptions: candidate.exceptions ?? null,
    source: { kind: "knowledge-doc", docId: "doc-1", nodeId: "n1" },
    checkSpec: candidate.checkSpec ?? null,
    severity: "minor",
    enabled: true,
    status: "approved",
    humanEdited: false,
    provenance: null,
    createdBy: "alice",
    reviewedBy: "bob",
    version: 1,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  }
}

/** The initial applicability row extraction proposes from a non-global hint. */
function rowFromScopeHint(rule: StyleRule, candidate: StyleRuleCandidate, id: string): RuleApplicability {
  const [targetType, targetId] = candidate.scopeHint.split(":")
  return {
    id,
    ruleId: rule.id,
    targetType: targetType as RuleApplicability["targetType"],
    targetId,
    relationship: "likely_applies",
    confidence: 0.8,
    reason: null,
    assignedBy: "model",
    createdBy: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  }
}

describe("extraction → applicability → prompt", () => {
  const candidates = parseStyleRuleCandidates(MODEL_RESPONSE)
  const rules = candidates.map((c, i) => approve(c, `rule-${i}`))
  const rows = candidates
    .map((c, i) => (c.scopeHint === "global" ? null : rowFromScopeHint(rules[i], c, `app-${i}`)))
    .filter((row): row is RuleApplicability => row !== null)
  const index = buildApplicabilityIndex(rows)

  it("parses all three candidates out of a realistic model response", () => {
    expect(candidates).toHaveLength(3)
  })

  it("gives a Psalms cell the global rule plus the poetry rule, and not the gospel one", () => {
    const coords = cellCoordinates(
      { id: "cell-1", globalReferences: ["PSA 23:1"] },
      { fileId: "file-psa", bookCode: "PSA" },
      bookGenre,
    )
    expect(coords.genre).toBe("poetry")

    const effective = resolveEffectiveRules(rules, index, coords)
    const block = buildStyleRulesBlock(effective.map((e) => e.rule.instruction))

    expect(block).toContain("Use the covenant name in small caps.")
    expect(block).toContain("Keep parallel lines on separate lines.")
    expect(block).not.toContain("Prefer short sentences in narrative.")
  })

  it("gives a Luke cell the global rule plus the gospel rule, and not the poetry one", () => {
    const coords = cellCoordinates(
      { id: "cell-2", globalReferences: ["LUK 1:1"] },
      { fileId: "file-luk", bookCode: "LUK" },
      bookGenre,
    )
    const block = buildStyleRulesBlock(
      resolveEffectiveRules(rules, index, coords).map((e) => e.rule.instruction),
    )

    expect(block).toContain("Use the covenant name in small caps.")
    expect(block).toContain("Prefer short sentences in narrative.")
    expect(block).not.toContain("Keep parallel lines on separate lines.")
  })

  it("carries only the global rule for a cell with no scripture coordinates", () => {
    const coords = cellCoordinates({ id: "cell-3" }, { fileId: "file-notes" }, bookGenre)
    const block = buildStyleRulesBlock(
      resolveEffectiveRules(rules, index, coords).map((e) => e.rule.instruction),
    )

    expect(block).toBe(
      "Style rules that apply to this passage (MUST follow):\n- Use the covenant name in small caps.",
    )
  })

  it("honours a human exclusion on the exact cell over the inherited genre rule", () => {
    const poetryRule = rules[0]
    const excluded = buildApplicabilityIndex([
      ...rows,
      {
        ...rowFromScopeHint(poetryRule, candidates[0], "app-x"),
        id: "app-exclude",
        targetType: "segment",
        targetId: "cell-1",
        relationship: "excluded",
        assignedBy: "human",
      },
    ])
    const coords = cellCoordinates(
      { id: "cell-1", globalReferences: ["PSA 23:1"] },
      { fileId: "file-psa", bookCode: "PSA" },
      bookGenre,
    )

    const block = buildStyleRulesBlock(
      resolveEffectiveRules(rules, excluded, coords).map((e) => e.rule.instruction),
    )
    expect(block).not.toContain("Keep parallel lines on separate lines.")
    expect(block).toContain("Use the covenant name in small caps.")
  })

  it("emits nothing at all when the library is empty — prompts stay untouched", () => {
    const coords = cellCoordinates({ id: "cell-4" }, { fileId: "f" }, bookGenre)
    expect(
      buildStyleRulesBlock(
        resolveEffectiveRules([], buildApplicabilityIndex([]), coords).map((e) => e.rule.instruction),
      ),
    ).toBe("")
  })

  it("compiles no engine rules from this library — none of the candidates carried a checkSpec", () => {
    expect(compileStyleRulesToTranslationRules(rules)).toEqual([])
  })
})
