import type { TranslationRule, RuleInfraction, InfractionSpan } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"
import { isBibleCheckId } from "../../../db/shared/bible-checks/types"
import { bibleCheckInfraction, type BibleCellCheckInput } from "./bible-check-rules"
import type { BuiltinCheckRunContext } from "@/lib/lqa/builtin-run-context"
import { suggestionFor } from "@/lib/lqa/check-functions/old-orthography"
import { compiledPattern, prefilterForPattern } from "@/lib/terminology/match"
import { catastrophicPatternReason } from "../../../db/shared/regex-safety"
import { AnchorIndex, prefilterMode, verifyRejected } from "@/lib/terminology/prefilter"

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
// AQU-2654: the cache is the terminology matcher's, so a concept's pattern is
// compiled once for the editor's highlights AND its `term:` rules.
//
// Every rule pattern is screened for catastrophic backtracking first: rules are
// stored project / org settings any editor can write, and one `(a+)+$` would
// freeze every collaborator's editor on the keystroke path. The verdict is
// cached per pattern so the screen runs once, not per cell.
const patternVerdicts = new Map<string, boolean>()
function compile(pattern: string, flags: string): RegExp | null {
  let safe = patternVerdicts.get(pattern)
  if (safe === undefined) {
    safe = catastrophicPatternReason(pattern) === null
    if (patternVerdicts.size >= 2048) patternVerdicts.clear()
    patternVerdicts.set(pattern, safe)
  }
  return safe ? compiledPattern(pattern, flags) : null
}

/**
 * Every match of a cached global regex in `text`, as `text.matchAll(re)` yields
 * them — zero-length matches included, the index advanced past them by a code
 * point under `u`. `matchAll` clones the regex on every call, and a clone of a
 * terminology pattern can cost V8 a second compile of a pattern that takes
 * milliseconds (AQU-2654); this runs the cached regex itself.
 */
function allMatches(re: RegExp, text: string): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, text: m[0] })
    // Every caller compiles with `g`; without it `exec` would never advance.
    if (!re.global) break
    if (m[0] === "") {
      const at = re.lastIndex
      const code = re.unicode ? text.codePointAt(at) : undefined
      re.lastIndex = at + (code !== undefined && code > 0xffff ? 2 : 1)
    }
  }
  re.lastIndex = 0
  return out
}

/**
 * How one rule array is walked for a cell (AQU-2654).
 *
 * A project with a glossary has two `term:` rules or more per concept, and a
 * cell's source mentions a handful of concepts. A `term:` rule can only fire
 * when its source pattern occurs, so the rules whose pattern cannot occur in
 * this cell's source are not visited at all: `index` answers "which of them
 * may" in one pass over the text (see lib/terminology/prefilter — a superset
 * of the patterns that match, never a miss), and `always` lists everything
 * that has no such precondition. Both hold positions in the rule array, so
 * merging them walks the surviving rules in the caller's order.
 */
interface RulePlan {
  length: number
  first: TranslationRule | undefined
  last: TranslationRule | undefined
  /** Builtin checks that run even on an empty target. */
  emptyAware: number[]
  /** Rules checked for every cell with a translation. */
  always: number[]
  /** `term:` rules gated on their source pattern; null when there are none. */
  index: AnchorIndex | null
  indexed: number[]
  /** Per source text: the rule positions to check, ascending. */
  byText: Map<string, readonly number[]>
}

const plans = new WeakMap<readonly TranslationRule[], RulePlan>()
const MAX_PLANNED_TEXTS = 4096

/** The source pattern a compiled terminology rule is conditional on. */
function termSourcePattern(rule: TranslationRule): string | undefined {
  if (!rule.id.startsWith("term:")) return undefined
  const check = rule.check
  if (check.type === "source-requires-target") return check.sourcePattern
  if (check.type === "target-forbids") return check.sourcePattern
  return undefined
}

function planFor(rules: readonly TranslationRule[]): RulePlan {
  const cached = plans.get(rules)
  // Callers pass a fresh array per rule set; the three fields catch one that
  // was grown or re-pointed in place.
  if (
    cached &&
    cached.length === rules.length &&
    cached.first === rules[0] &&
    cached.last === rules[rules.length - 1]
  ) {
    return cached
  }
  const plan: RulePlan = {
    length: rules.length,
    first: rules[0],
    last: rules[rules.length - 1],
    emptyAware: [],
    always: [],
    index: null,
    indexed: [],
    byText: new Map(),
  }
  rules.forEach((rule, i) => {
    if (rule.check.type === "builtin" && BUILTIN_CHECKS[rule.check.checkId]?.runsOnEmptyTarget) {
      plan.emptyAware.push(i)
      return
    }
    const pattern = termSourcePattern(rule)
    const prefilter = pattern === undefined ? undefined : prefilterForPattern(pattern)
    if (!prefilter || prefilter.always) {
      plan.always.push(i)
      return
    }
    plan.index ??= new AnchorIndex()
    plan.index.add(i, prefilter)
    plan.indexed.push(i)
  })
  plans.set(rules, plan)
  return plan
}

/** Positions of the rules to check for a cell with this source, ascending. */
function rulesToCheck(plan: RulePlan, source: string): readonly number[] {
  if (!plan.index) return plan.always
  let order = plan.byText.get(source)
  if (order === undefined) {
    const candidates = plan.index.candidates(source)
    const merged: number[] = []
    let a = 0
    let c = 0
    while (a < plan.always.length || c < candidates.length) {
      if (c >= candidates.length || (a < plan.always.length && plan.always[a] < candidates[c])) {
        merged.push(plan.always[a++])
      } else {
        merged.push(candidates[c++])
      }
    }
    order = merged
    if (plan.byText.size >= MAX_PLANNED_TEXTS) plan.byText.clear()
    plan.byText.set(source, order)
  }
  return order
}

/** `verify` mode: every indexed rule that was skipped must really not apply. */
function verifySkipped(
  plan: RulePlan,
  rules: readonly TranslationRule[],
  checked: readonly number[],
  source: string,
): void {
  const visited = new Set(checked)
  for (const i of plan.indexed) {
    if (visited.has(i)) continue
    const rule = rules[i]
    const pattern = termSourcePattern(rule)
    if (pattern === undefined) continue
    const caseSensitive = "caseSensitive" in rule.check && rule.check.caseSensitive
    verifyRejected(pattern, caseSensitive ? "u" : "iu", source)
  }
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

  const plan = planFor(enabledRules)

  // Step 1: empty-aware builtin checks fire even when target is empty.
  for (const i of plan.emptyAware) {
    const rule = enabledRules[i]
    if (rule.check.type !== "builtin") continue
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

  // Step 3: regular checks (the empty-aware builtins are already handled) —
  // every rule but the `term:` rules whose source pattern cannot occur here.
  const source = effectiveSourceText(cell)
  const order = rulesToCheck(plan, source)
  if (plan.index && prefilterMode() === "verify") verifySkipped(plan, enabledRules, order, source)
  for (const i of order) {
    const infraction = checkRule(enabledRules[i], cell, fileId, context)
    if (infraction) out.push(infraction)
  }
  return out
}

/**
 * Terminology rules (id `term:…`) are compiled by compileConceptsToRules using
 * the shared matcher in lib/terminology/match.ts, whose wildcard/boundary
 * patterns use Unicode property escapes (\p{L}) that REQUIRE the `u` flag.
 * Only terminology rules opt into `u`; all other (incl. user-authored)
 * patterns keep their original flags so a regex valid without `u` is never
 * silently disabled by becoming invalid under `u`.
 */
function unicodeFlag(rule: TranslationRule): string {
  return rule.id.startsWith("term:") ? "u" : ""
}

function caseInsensitiveFlag(check: TranslationRule["check"]): string {
  return (check.type === "source-requires-target" || check.type === "target-forbids") && check.caseSensitive
    ? ""
    : "i"
}

/**
 * AQU-2654: does this rule's SOURCE-side gate hold for this cell?
 *
 * Both terminology check shapes are gated on the source: a
 * `source-requires-target` rule produces nothing when the source bears no
 * instance of the concept, and a `target-forbids` rule carrying a
 * `sourcePattern` (AQU-1712) produces nothing for the same reason. A rule
 * whose gate is false therefore CANNOT yield an infraction on this cell, so
 * the hot keystroke path can drop it up front.
 *
 * This matters because the gate is **invariant while typing in the target**:
 * the cell's source text does not change, so re-scanning every rule's source
 * pattern on each keystroke is pure waste. On the BibleProject French project
 * (664 active concepts → 1328 compiled rules, affix matching on) exactly 2
 * rules pass the gate on a typical cell, yet all 1328 source patterns — each
 * ~4.5 KB of affix alternation — were re-scanned every ~150 ms live-check
 * tick: ~32 ms of main-thread regex per keystroke, which is the reported
 * "the app takes a deep breath after every letter typed".
 *
 * A failed compile returns false, matching both branches of `checkRule`,
 * which bail with no infraction when their source regex does not compile.
 *
 * Note this is a necessary condition, not a sufficient one — a rule that
 * passes the gate still has to be run by `checkRulesForCell` to find out
 * whether it actually infracts.
 */
export function ruleSourceGateMatches(rule: TranslationRule, cell: CellData): boolean {
  const check = rule.check
  if (check.type !== "source-requires-target" && check.type !== "target-forbids") return true
  const pattern = check.sourcePattern
  if (pattern === undefined) return true
  const re = compile(pattern, "g" + caseInsensitiveFlag(check) + unicodeFlag(rule))
  if (!re) return false
  return sourceBearsPattern(effectiveSourceText(cell), re)
}

/**
 * The rules whose source gate holds for this cell, in the caller's order: the
 * same answer as `rules.filter((rule) => ruleSourceGateMatches(rule, cell))`.
 *
 * It asks the plan's index first, as `checkRulesForCell` does, so a `term:`
 * rule whose source pattern cannot occur in this source is dropped without
 * its regex being compiled. Every editor row asks this when it mounts; testing
 * each rule's gate directly made the first row compile the source pattern of
 * every glossary term — about 1.5 s of main thread for 664 terms, before any
 * row could paint.
 */
export function rulesPassingSourceGate(cell: CellData, rules: TranslationRule[]): TranslationRule[] {
  if (rules.length === 0) return rules
  const plan = planFor(rules)
  if (!plan.index) return rules.filter((rule) => ruleSourceGateMatches(rule, cell))
  const source = effectiveSourceText(cell)
  const order = rulesToCheck(plan, source)
  if (prefilterMode() === "verify") verifySkipped(plan, rules, order, source)
  // `order` leaves out the empty-aware builtins, which carry no source gate.
  const positions =
    plan.emptyAware.length === 0 ? order : [...plan.emptyAware, ...order].sort((a, b) => a - b)
  const passing: TranslationRule[] = []
  for (const i of positions) {
    if (ruleSourceGateMatches(rules[i], cell)) passing.push(rules[i])
  }
  return passing
}

/**
 * True when `source` has at least one NON-EMPTY match for `re`. Zero-length
 * matches are not instances of a term — the same rule both source-gated
 * branches of `checkRule` apply.
 */
function sourceBearsPattern(source: string, re: RegExp): boolean {
  // `matchAll` works on a clone, so the cached regex keeps no state.
  for (const m of source.matchAll(re)) {
    if (m.index !== undefined && m[0].length > 0) return true
  }
  return false
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
  const uflag = unicodeFlag(rule)
  const caseFlag = caseInsensitiveFlag(check)
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
      // The predicate itself lives in `ruleSourceGateMatches` (AQU-2654) so the
      // editor's per-cell prefilter and this branch can never disagree about
      // which cells a forbidden rendering applies to.
      if (check.sourcePattern !== undefined && !ruleSourceGateMatches(rule, cell)) return null
      const re = compile(check.targetPattern, "g" + caseFlag + uflag)
      if (!re) return null
      const spans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of allMatches(re, cell.translated)) {
        spans.push({ side: "target", start: m.index, end: m.index + m.text.length, matchedText: m.text })
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
      const sourceSpans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of allMatches(sourceRe, source)) {
        if (m.text.length === 0) continue
        sourceSpans.push({ side: "source", start: m.index, end: m.index + m.text.length, matchedText: m.text })
      }
      if (sourceSpans.length === 0) return null // source pattern not present → rule doesn't apply
      const targetRe = compile(check.targetPattern, "g" + caseFlag + uflag)
      if (!targetRe) return null
      const targetSpans: import("@/lib/parsers/types").InfractionSpan[] = []
      for (const m of allMatches(targetRe, cell.translated)) {
        if (m.text.length === 0) continue
        targetSpans.push({ side: "target", start: m.index, end: m.index + m.text.length, matchedText: m.text })
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
      // AQU-1735 adds `bookNames` the same way, AQU-2430 `numberFormat`,
      // AQU-2628 `orthography`.
      const runContext =
        check.punctuation || check.bookNames?.length || check.numberFormat || check.orthography
          ? {
              ...(check.punctuation ? { punctuation: check.punctuation } : {}),
              ...(check.bookNames?.length ? { bookNames: check.bookNames } : {}),
              ...(check.numberFormat ? { numberFormat: check.numberFormat } : {}),
              ...(check.orthography ? { orthography: check.orthography } : {}),
            }
          : undefined
      const spans = runContext ? def.run(source, cell.translated, runContext) : def.run(source, cell.translated)
      if (!spans || spans.length === 0) return null
      return {
        ruleId: rule.id,
        cellId: cell.id,
        fileId,
        reason: `builtin:${check.checkId}`,
        reasonParams:
          check.checkId === "placeholder-integrity"
            ? placeholderIntegrityParams(spans)
            : check.checkId === "old-orthography"
              ? oldOrthographyParams(spans, runContext)
              : undefined,
        spans,
      }
    }
  }
}

/**
 * `builtin:old-orthography` (AQU-2628) names the word and what the lane's
 * rules make of it, so the finding reads "use “şahar” for “shahar”" rather
 * than a rule number. Both halves are raw cell content derived from it, so
 * they are interpolated as vars and never routed through `t()`.
 */
function oldOrthographyParams(
  spans: InfractionSpan[],
  context: BuiltinCheckRunContext | undefined,
): Record<string, string> | undefined {
  const suggestion = suggestionFor(spans, context)
  return suggestion ? { word: suggestion.word, suggestion: suggestion.suggestion } : undefined
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
