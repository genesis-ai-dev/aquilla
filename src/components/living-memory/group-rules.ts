import type { TranslationRule } from "@/lib/parsers/types"

export interface StandardGroup {
  mustPreserve: TranslationRule[]
  mustInclude: TranslationRule[]
  mustNotContain: TranslationRule[]
}

/**
 * Group enabled rules by check type for the Living Memory Standards section.
 * Disabled rules are excluded.
 */
export function groupRulesByType(rules: TranslationRule[]): StandardGroup {
  const enabled = rules.filter((r) => r.enabled)
  const group: StandardGroup = {
    mustPreserve: [],
    mustInclude: [],
    mustNotContain: [],
  }
  for (const rule of enabled) {
    switch (rule.check.type) {
      case "source-target-match":
        group.mustPreserve.push(rule)
        break
      case "source-requires-target":
        group.mustInclude.push(rule)
        break
      case "target-forbids":
        group.mustNotContain.push(rule)
        break
    }
  }
  return group
}
