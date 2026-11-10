import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"
import { isBibleCheckId } from "../../../db/shared/bible-checks/types"
import { bibleCheckInfraction, type BibleCellCheckInput } from "./bible-check-rules"

/**
 * AQU-1688: per-cell inputs for checks that need more than the cell's own
 * text and source. Each field is about THIS cell only, so a keystroke in one
 * cell still never re-evaluates another. A missing field means the checks
 * that need it produce nothing for this cell.
 */
export interface CellCheckContext {
  /** Pack facts and the Language profile for the Bible data checks. */
  bible?: BibleCellCheckInput
}

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
 * AQU-1509: a rule's scope relative to the lane being viewed — `"all"` applies
 * in every lane, `"this"` only in `lane`, `"other"` only in some other lane
 * (so it is NOT enforced in `lane`). Must agree with `rulesForLane`: a rule is
 * `"other"` exactly when that filter drops it.
 */
export type RuleLaneScope = "all" | "this" | "other"

export function ruleLaneScope(rule: TranslationRule, lane: string): RuleLaneScope {
  if (rule.scope !== "lane") return "all"
  return (rule.lane ?? "") === lane ? "this" : "other"
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
 * `context` carries this cell's extra inputs (AQU-1688); omit it and the
 * checks that need it stay silent.
 */
export function checkRulesForCell(
  cell: CellData,
  fileId: string,
  enabledRules: TranslationRule[],
  context?: CellCheckContext,
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
    const infraction = checkRule(rule, cell, fileId, context)
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
    const infraction = checkRule(rule, cell, fileId, context)
    if (infraction) out.push(infraction)
  }
  return out
}

function checkRule(
  rule: TranslationRule,
  cell: CellData,
  fileId: string,
  context: CellCheckContext | undefined,
): RuleInfraction | null {
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
      // AQU-1712: an optional SOURCE condition. A forbidden rendering is
      // usually an ordinary word that is wrong only as a rendering of one
      // concept, so a compiled `term:` rule carries that concept's source
      // pattern and the check applies only to a cell whose source bears it —
      // the same pattern and flags the concept's approved rule matches its
      // source side with. Autopilot's lintTerminology and the worker's
      // project-wide scan already judge it that way; this is what makes the
      // editor agree (AQU-1711). Hand-authored rules carry no `sourcePattern`
      // and stay unconditional.
      if (check.sourcePattern !== undefined) {
        const sourceRe = compile(check.sourcePattern, "g" + caseFlag + uflag)
        if (!sourceRe) return null
        // `matchAll` works on a clone, so the cached regex keeps no state.
        // Zero-length matches are not instances, as in source-requires-target.
        let sourceBearsTerm = false
        for (const m of source.matchAll(sourceRe)) {
          if (m.index !== undefined && m[0].length > 0) {
            sourceBearsTerm = true
            break
          }
        }
        if (!sourceBearsTerm) return null
      }
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
      if (isBibleCheckId(check.checkId)) {
        return bibleCheckInfraction(rule.id, check.checkId, cell.id, fileId, cell.translated, context?.bible)
      }
      // AQU-1906: the lane's punctuation conventions ride on the rule's check
      // descriptor (resolveBuiltinRules stamped them), so no per-cell input is
      // needed for them and a keystroke still re-evaluates one cell. Built only
      // when there are conventions to pass: this runs once per rule per cell,
      // and a whole Bible is ~31k cells × ~20 rules (AQU-1864).
      // AQU-1735 adds `bookNames` the same way, AQU-2430 `numberFormat`.
      const spans = check.punctuation || check.bookNames?.length || check.numberFormat
        ? def.run(source, cell.translated, {
            ...(check.punctuation ? { punctuation: check.punctuation } : {}),
            ...(check.bookNames?.length ? { bookNames: check.bookNames } : {}),
            ...(check.numberFormat ? { numberFormat: check.numberFormat } : {}),
          })
        : def.run(source, cell.translated)
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

/**
 * AQU-2350: does `rule` have anything to say about this cell at all?
 *
 * `checkRulesForCell` returns no infraction in two very different cases — the
 * cell satisfied the rule, and the rule never reached the cell. A surface that
 * partitions cells into "breaking" and "following" by taking everything that is
 * not breaking conflates the two and reports vacuous compliance: the term panel
 * listed cells whose source never contains the term as "Following this rule",
 * burying the real usage a reviewer opened the panel to compare. Those surfaces
 * filter the second list with this predicate.
 *
 * Applicability is the rule's own source precondition, read off the same
 * patterns and flags `checkRule` matches with, so the two always agree:
 *  - `source-requires-target` and `source-target-match` can only fire where the
 *    source pattern occurs, so that occurrence is the precondition;
 *  - `target-forbids` carries an optional source condition since AQU-1712 — a
 *    compiled `term:` rule applies only where the source bears the concept,
 *    while a hand-authored rule with no `sourcePattern` constrains every
 *    translated cell, so a cell that simply lacks the forbidden text really is
 *    following it;
 *  - `builtin` checks constrain every translated cell the same way.
 *
 * An uncompilable pattern reaches nothing: `checkRule` raises no infraction
 * from one either, so no cell can demonstrate compliance with it.
 */
export function ruleAppliesToCell(rule: TranslationRule, cell: CellData): boolean {
  const check = rule.check
  const source = effectiveSourceText(cell)
  // Same flag derivation as `checkRule`.
  const uflag = rule.id.startsWith("term:") ? "u" : ""
  const caseFlag =
    (check.type === "source-requires-target" || check.type === "target-forbids") && check.caseSensitive
      ? ""
      : "i"
  switch (check.type) {
    case "builtin":
      return true
    case "target-forbids":
      if (check.sourcePattern === undefined) return true
      return sourcePatternOccurs(compile(check.sourcePattern, "g" + caseFlag + uflag), source, true)
    case "source-requires-target":
      return sourcePatternOccurs(compile(check.sourcePattern, "g" + caseFlag + uflag), source, true)
    case "source-target-match":
      // `checkRule` compiles this one "gi" and counts a zero-length hit.
      return sourcePatternOccurs(compile(check.pattern, "gi"), source, false)
  }
}

/**
 * Whether a compiled source pattern hits `text`. `requireNonEmpty` mirrors
 * whether the matching branch of `checkRule` discards zero-length matches.
 *
 * The regex comes from the module cache and carries `g`; `matchAll` iterates a
 * clone, but `lastIndex` is cleared on both sides anyway so this can never be
 * the reason a later caller starts mid-string.
 */
function sourcePatternOccurs(re: RegExp | null, text: string, requireNonEmpty: boolean): boolean {
  if (!re) return false
  re.lastIndex = 0
  try {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue
      if (!requireNonEmpty || m[0].length > 0) return true
    }
    return false
  } finally {
    re.lastIndex = 0
  }
}
