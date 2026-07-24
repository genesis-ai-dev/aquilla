import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"

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
  if (enabledRules.length === 0) return []
  const out: RuleInfraction[] = []

  // Step 1: empty-aware builtin checks fire even when target is empty.
  for (const rule of enabledRules) {
    if (rule.check.type !== "builtin") continue
    const def = BUILTIN_CHECKS[rule.check.checkId]
    if (!def?.runsOnEmptyTarget) continue
    const infraction = checkRule(rule, cell, fileId)
    if (infraction) out.push(infraction)
  }

  // Step 2: short-circuit on empty target for the rest.
  if (cell.status === "empty" || !cell.translated.trim()) return out

  // Step 3: regular checks (skip the empty-aware builtins already handled).
  for (const rule of enabledRules) {
    if (rule.check.type === "builtin") {
      const def = BUILTIN_CHECKS[rule.check.checkId]
      if (def?.runsOnEmptyTarget) continue
    }
    const infraction = checkRule(rule, cell, fileId)
    if (infraction) out.push(infraction)
  }
  return out
}

function checkRule(rule: TranslationRule, cell: CellData, fileId: string): RuleInfraction | null {
  // SUB-28: media sections match rules against their transcript (the displayed
  // source), never the import filename / span offsets stay display-aligned.
  const source = effectiveSourceText(cell)
  const check = rule.check
  // Terminology rules (id `term:…`) are compiled by compileConceptsToRules using
  // the shared matcher in lib/terminology/match.ts, whose wildcard/boundary
  // patterns use Unicode property escapes (\p{L}) that REQUIRE the `u` flag.
  // Only terminology rules opt into `u`; all other (incl. user-authored)
  // patterns keep their original flags so a regex valid without `u` is never
  // silently disabled by becoming invalid under `u`.
  const uflag = rule.id.startsWith("term:") ? "u" : ""
  switch (check.type) {
    case "target-forbids": {
      const re = compile(check.targetPattern, "gi" + uflag)
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
      const sourceRe = compile(check.sourcePattern, "gi" + uflag)
      if (!sourceRe) return null
      sourceRe.lastIndex = 0
      const sourceSpans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of source.matchAll(sourceRe)) {
        if (m.index === undefined) continue
        sourceSpans.push({ side: "source", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
      }
      if (sourceSpans.length === 0) return null // source pattern not present → rule doesn't apply
      const targetRe = compile(check.targetPattern, "i" + uflag)
      if (!targetRe) return null
      if (targetRe.test(cell.translated)) return null // target satisfies the requirement
      return {
        ruleId: rule.id, cellId: cell.id, fileId,
        message: `"${rule.name}": source matches pattern but target does not`,
        spans: sourceSpans,
      }
    }
    case "source-target-match": {
      const re = compile(check.pattern, "gi")
      if (!re) return null
      re.lastIndex = 0 // cached regex — clear any leftover state before matchAll
      const sourceSpans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of source.matchAll(re)) {
        if (m.index === undefined) continue
        sourceSpans.push({ side: "source", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
      }
      if (sourceSpans.length === 0) return null
      re.lastIndex = 0
      const targetHasMatch = re.test(cell.translated)
      re.lastIndex = 0 // reset after test() advances it on a /g regex
      if (targetHasMatch) return null
      return {
        ruleId: rule.id, cellId: cell.id, fileId,
        message: `"${rule.name}": pattern found in source but missing in target`,
        spans: sourceSpans,
      }
    }
    case "builtin": {
      const def = BUILTIN_CHECKS[check.checkId]
      if (!def) return null
      const spans = def.run(source, cell.translated)
      if (!spans || spans.length === 0) return null
      const message = typeof def.message === "function" ? def.message(spans) : def.message
      return {
        ruleId: rule.id,
        cellId: cell.id,
        fileId,
        message: `"${rule.name}": ${message}`,
        spans,
      }
    }
  }
}
