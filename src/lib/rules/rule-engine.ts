import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

// Compiled-regex cache. Rule patterns are stable across cells and across
// calls; without this the hot keystroke path recompiles every pattern for
// every cell. Failed compiles are cached as null so we don't retry each time.
const regexCache = new Map<string, RegExp | null>()
function compile(pattern: string, flags: string): RegExp | null {
  const key = `${flags}\u0001${pattern}`
  if (regexCache.has(key)) return regexCache.get(key) ?? null
  let re: RegExp | null
  try { re = new RegExp(pattern, flags) } catch { re = null }
  regexCache.set(key, re)
  return re
}

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
  const check = rule.check
  switch (check.type) {
    case "target-forbids": {
      const re = compile(check.targetPattern, "i")
      if (!re) return null
      if (re.test(cell.translated)) {
        return {
          ruleId: rule.id, cellId: cell.id, fileId,
          message: `"${rule.name}": target contains forbidden pattern`,
        }
      }
      return null
    }
    case "source-requires-target": {
      const sourceRe = compile(check.sourcePattern, "i")
      if (!sourceRe) return null
      if (!sourceRe.test(cell.original)) return null
      const targetRe = compile(check.targetPattern, "i")
      if (!targetRe) return null
      if (!targetRe.test(cell.translated)) {
        return {
          ruleId: rule.id, cellId: cell.id, fileId,
          message: `"${rule.name}": source matches pattern but target does not`,
        }
      }
      return null
    }
    case "source-target-match": {
      const re = compile(check.pattern, "gi")
      if (!re) return null
      // String.prototype.match with a /g/ regex resets lastIndex, so reusing
      // the cached instance is safe here.
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
}
