/**
 * style-rule-bridge.ts — compile style-rule library entries that carry a
 * deterministic `checkSpec` into `TranslationRule`s (AQU-934 phase 2).
 *
 * The rule engine, waivers, health penalties and autofix all speak
 * `TranslationRule`. Rather than teach each of them a second rule shape, a
 * library rule with an enforceable check is projected into one here and merged
 * at the `useRules` composition point. Ids carry a `lib:` prefix, following the
 * existing `builtin:` / `term:` convention — code that branches on rule
 * provenance keys off the prefix.
 *
 * Instruction-only rules (no `checkSpec`) are deliberately NOT compiled: they
 * are unenforceable by regex and reach the model through prompt injection
 * instead. That is the normal case, not a degraded one.
 */
import type { TranslationRule } from "@/lib/parsers/types"

import type { StyleRule } from "./style-rule-types"

/** Id prefix marking a TranslationRule projected from the style-rule library. */
export const LIBRARY_RULE_ID_PREFIX = "lib:"

/** Longest rule name rendered in rule lists before it is elided. */
const MAX_NAME_CHARS = 60

export function isLibraryRuleId(id: string): boolean {
  return id.startsWith(LIBRARY_RULE_ID_PREFIX)
}

/** The style-rule id a compiled TranslationRule came from, else null. */
export function styleRuleIdFromRuleId(id: string): string | null {
  return isLibraryRuleId(id) ? id.slice(LIBRARY_RULE_ID_PREFIX.length) : null
}

/**
 * First sentence (or clause) of an instruction, capped for list display. The
 * full instruction stays in `description`, so nothing is lost.
 */
function ruleName(instruction: string): string {
  const collapsed = instruction.trim().replace(/\s+/g, " ")
  const sentenceEnd = collapsed.search(/[.;:]\s|[.;:]$/)
  const firstSentence = sentenceEnd > 0 ? collapsed.slice(0, sentenceEnd) : collapsed
  if (firstSentence.length <= MAX_NAME_CHARS) return firstSentence
  const slice = firstSentence.slice(0, MAX_NAME_CHARS)
  const lastSpace = slice.lastIndexOf(" ")
  return `${(lastSpace > MAX_NAME_CHARS / 2 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`
}

/**
 * Project the enforceable subset of a style-rule library into TranslationRules.
 *
 * Only `approved` + `enabled` rules with a `checkSpec` compile — a proposed
 * rule must never lint a translator's work before a human has approved it.
 * Applicability is NOT applied here: these rules are scoped per cell by the
 * resolver at the point of use.
 */
export function compileStyleRulesToTranslationRules(styleRules: StyleRule[]): TranslationRule[] {
  const compiled: TranslationRule[] = []
  for (const rule of styleRules) {
    if (rule.status !== "approved" || !rule.enabled || !rule.checkSpec) continue
    compiled.push({
      id: `${LIBRARY_RULE_ID_PREFIX}${rule.id}`,
      name: ruleName(rule.instruction),
      description: rule.instruction.trim(),
      severity: rule.severity,
      source: "llm",
      // Org-owned library rules still lint one project at a time; org-vs-project
      // ownership lives on the style rule itself, not on this projection.
      scope: "project",
      check: rule.checkSpec,
      enabled: true,
      createdAt: rule.createdAt,
    })
  }
  return compiled
}
