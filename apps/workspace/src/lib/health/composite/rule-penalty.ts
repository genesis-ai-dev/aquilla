import type { RuleInfraction, TranslationRule, HealthRulePenaltiesConfig } from "@/lib/parsers/types"

export function rulePenalty(
  infractions: RuleInfraction[],
  rules: TranslationRule[],
  penalties: HealthRulePenaltiesConfig,
  cap: number,
): number {
  const severity = new Map<string, "major" | "minor">()
  for (const r of rules) severity.set(r.id, r.severity)
  let raw = 0
  for (const i of infractions) {
    const s = severity.get(i.ruleId) ?? "minor"
    raw += s === "major" ? penalties.major : penalties.minor
  }
  return Math.min(raw, cap)
}
