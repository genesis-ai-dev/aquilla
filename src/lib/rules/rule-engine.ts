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
      const cellInf = checkRulesForCell(cell, fileId, enabledRules)
      if (cellInf.length > 0) infractions.set(cell.id, cellInf)
    }
  }

  return infractions
}

/**
 * Run every enabled rule against one cell. Returns its infractions in an
 * array (possibly empty). Exported so incremental callers can re-check only
 * the cells whose content changed — the rule set is pure per-cell, so a
 * keystroke in X never requires re-evaluating rules on any Y.
 *
 * Pass pre-filtered `enabledRules` to avoid re-filtering on every call.
 */
export function checkRulesForCell(
  cell: CellData,
  fileId: string,
  enabledRules: TranslationRule[],
): RuleInfraction[] {
  if (cell.status === "empty" || !cell.translated.trim()) return []
  if (enabledRules.length === 0) return []
  const out: RuleInfraction[] = []
  for (const rule of enabledRules) {
    const infraction = checkRule(rule, cell, fileId)
    if (infraction) out.push(infraction)
  }
  return out
}

function checkRule(rule: TranslationRule, cell: CellData, fileId: string): RuleInfraction | null {
  const check = rule.check
  switch (check.type) {
    case "target-forbids": {
      const re = compile(check.targetPattern, "gi")
      if (!re) return null
      const spans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of cell.translated.matchAll(re)) {
        if (m.index === undefined) continue
        spans.push({ side: "target", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
      }
      if (spans.length === 0) return null
      return {
        ruleId: rule.id, cellId: cell.id, fileId,
        message: `"${rule.name}": target contains forbidden pattern`,
        spans,
      }
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
          spans: [],
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
          spans: [],
        }
      }
      return null
    }
  }
}
