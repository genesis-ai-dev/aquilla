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

/**
 * AQU-609: restrict a merged rules array to the given target-language lane.
 * Lane-scoped rules apply only when their `lane` matches (`''` = the
 * project-default lane, same convention as cells/AQU-538); org, project,
 * builtin, and terminology rules apply in every lane. Callers evaluating
 * against a lane-bound cell view (editor, health, drafting, autopilot) filter
 * here; management surfaces keep the full list.
 */
export function rulesForLane(
  rules: TranslationRule[],
  lane: string,
): TranslationRule[] {
  return rules.filter((r) => r.scope !== "lane" || (r.lane ?? "") === lane)
}

/**
 * Distinct lanes currently holding at least one lane-scoped rule, in
 * first-appearance order. Drives the Rules-surface lane filter: a project can
 * carry 150+ target lanes, so the filter lists only lanes that actually have
 * rules (an archived lane with a leftover rule still shows, on purpose).
 */
export function lanesWithRules(rules: TranslationRule[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rules) {
    if (r.scope !== "lane") continue
    const lane = r.lane ?? ""
    if (seen.has(lane)) continue
    seen.add(lane)
    out.push(lane)
  }
  return out
}

/**
 * Apply the Rules-surface lane filter. `"all"` = every rule, `"project"` =
 * only rules that apply in every lane, `"lane:<tag>"` = only that lane's
 * rules (`"lane:"` = the default lane). Display-only — evaluation filtering
 * is `rulesForLane` above.
 */
export function filterRulesForDisplay(
  rules: TranslationRule[],
  filter: string,
): TranslationRule[] {
  if (filter === "all") return rules
  if (filter === "project") return rules.filter((r) => r.scope !== "lane")
  const lane = filter.slice("lane:".length)
  return rules.filter((r) => r.scope === "lane" && (r.lane ?? "") === lane)
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
    // AQU-646: a line carrying a recording is not an untranslated line. The
    // check functions take (source, target) strings and cannot see audio, so
    // the caller has to make the distinction — a dub with no text was being
    // reported as a MAJOR infraction on work that is finished.
    if (rule.check.checkId === "empty-target" && cell.hasOwnTake) continue
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
  const caseFlag =
    (check.type === "source-requires-target" || check.type === "target-forbids") && check.caseSensitive
      ? ""
      : "i"
  switch (check.type) {
    case "target-forbids": {
      const re = compile(check.targetPattern, "g" + caseFlag + uflag)
      if (!re) return null
      const spans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of cell.translated.matchAll(re)) {
        if (m.index === undefined) continue
        spans.push({ side: "target", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
      }
      if (spans.length === 0) return null
      return {
        ruleId: rule.id, cellId: cell.id, fileId,
        reason: "target-forbids",
        spans,
      }
    }
    case "source-requires-target": {
      const sourceRe = compile(check.sourcePattern, "g" + caseFlag + uflag)
      if (!sourceRe) return null
      sourceRe.lastIndex = 0
      const sourceSpans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of source.matchAll(sourceRe)) {
        if (m.index === undefined || m[0].length === 0) continue
        sourceSpans.push({ side: "source", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
      }
      if (sourceSpans.length === 0) return null // source pattern not present → rule doesn't apply
      const targetRe = compile(check.targetPattern, "g" + caseFlag + uflag)
      if (!targetRe) return null
      targetRe.lastIndex = 0
      const targetSpans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of cell.translated.matchAll(targetRe)) {
        if (m.index === undefined || m[0].length === 0) continue
        targetSpans.push({ side: "target", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
      }
      // Default assumption: instance counts add up 1:1. Too few source
      // counterparts blot the unmatched source hits; extra renderings blot
      // the surplus in the translation.
      if (targetSpans.length === sourceSpans.length) return null
      const tooFew = targetSpans.length < sourceSpans.length
      return {
        ruleId: rule.id, cellId: cell.id, fileId,
        reason: "source-requires-target",
        reasonParams: {
          sourceCount: String(sourceSpans.length),
          targetCount: String(targetSpans.length),
        },
        spans: tooFew
          ? sourceSpans.slice(targetSpans.length)
          : targetSpans.slice(sourceSpans.length),
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
        reason: "source-target-match",
        spans: sourceSpans,
      }
    }
    case "builtin": {
      const def = BUILTIN_CHECKS[check.checkId]
      if (!def) return null
      const spans = def.run(source, cell.translated)
      if (!spans || spans.length === 0) return null
      return {
        ruleId: rule.id,
        cellId: cell.id,
        fileId,
        reason: `builtin:${check.checkId}`,
        reasonParams:
          check.checkId === "placeholder-integrity" ? placeholderIntegrityParams(spans) : undefined,
        spans,
      }
    }
  }
}

/**
 * `builtin:placeholder-integrity` names the missing token(s) so the
 * translator can act (FRO-345) — the identity is already on each span's
 * `matchedText`, which is raw cell content and must never be routed through
 * `t()`. `count` drives the plural form ("Placeholder X" vs "Placeholders
 * X, Y") at render time.
 */
function placeholderIntegrityParams(spans: import("@/lib/parsers/types").InfractionSpan[]): Record<string, string> {
  const tokens = spans.map((s) => s.matchedText).filter(Boolean)
  return { tokens: tokens.join(", "), count: String(tokens.length) }
}
