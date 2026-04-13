import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

export function checkRules(
  fileCells: Map<string, CellData[]>,
  rules: TranslationRule[]
): Map<string, RuleInfraction[]> {
  const infractions = new Map<string, RuleInfraction[]>()
  const enabledRules = rules.filter((r) => r.enabled)
  if (enabledRules.length === 0) return infractions

  for (const [fileId, cells] of fileCells) {
    for (const cell of cells) {
      if (cell.status === "empty" || !cell.translated.trim()) continue

      for (const rule of enabledRules) {
        const infraction = checkRule(rule, cell, fileId)
        if (infraction) {
          const existing = infractions.get(cell.id) || []
          existing.push(infraction)
          infractions.set(cell.id, existing)
        }
      }
    }
  }

  return infractions
}

function checkRule(rule: TranslationRule, cell: CellData, fileId: string): RuleInfraction | null {
  try {
    const check = rule.check
    switch (check.type) {
      case "target-forbids": {
        const re = new RegExp(check.targetPattern, "i")
        if (re.test(cell.translated)) {
          return {
            ruleId: rule.id, cellId: cell.id, fileId,
            message: `"${rule.name}": target contains forbidden pattern`,
          }
        }
        return null
      }
      case "source-requires-target": {
        const sourceRe = new RegExp(check.sourcePattern, "i")
        if (!sourceRe.test(cell.original)) return null // rule doesn't apply
        const targetRe = new RegExp(check.targetPattern, "i")
        if (!targetRe.test(cell.translated)) {
          return {
            ruleId: rule.id, cellId: cell.id, fileId,
            message: `"${rule.name}": source matches pattern but target does not`,
          }
        }
        return null
      }
      case "source-target-match": {
        const re = new RegExp(check.pattern, "gi")
        const sourceMatches = cell.original.match(re)
        if (!sourceMatches || sourceMatches.length === 0) return null
        const targetMatches = cell.translated.match(re)
        if (!targetMatches || targetMatches.length === 0) {
          return {
            ruleId: rule.id, cellId: cell.id, fileId,
            message: `"${rule.name}": pattern found in source but missing in target`,
          }
        }
        return null
      }
    }
  } catch {
    // Invalid regex — skip rule silently
    return null
  }
}
