/**
 * AQU-2342: the ONE Checks list's row model.
 *
 * A project runs checks from five stores — project rules (some pinned to one
 * language lane), the organization's rules, style rules (the `style_rules`
 * table, narrowed by applicability rows to books, genres, files, sections or
 * ranges) and the app's built-in checks. The user sees them as one list: each
 * row says WHERE it applies with a scope chip, and the list is ordered most
 * specific scope first, the same order in which a narrower check wins.
 *
 * Pure: no React, no i18n. The list component turns chips into words.
 */

import { ruleLaneScope } from "@/lib/rules/rule-engine"
import type { TranslationRule } from "@/lib/parsers/types"
import type {
  ApplicabilityTargetType,
  RuleApplicability,
  StyleRule,
  StyleRuleScope,
} from "@/lib/rules/style-rule-types"
import { isBibleCheckId } from "../../../db/shared/bible-checks/types"

/** Where one check applies. One row may carry several (a style rule tied to two books). */
export type CheckScopeChip =
  | { kind: "org" }
  | { kind: "project" }
  | { kind: "builtin" }
  | { kind: "bible" }
  /** A project rule on a multi-lane project, relative to the lane being viewed. */
  | { kind: "lane"; relation: "all" | "this" | "other"; lane: string }
  /** A style rule's applicability target ("PSA", "poetry", a file id, "LUK 1:1-4"). */
  | { kind: "target"; targetType: ApplicabilityTargetType; targetId: string }
  /** A style rule that names a scope but has no applicability rows yet. */
  | { kind: "styleScope"; scope: StyleRuleScope }

interface RowBase {
  /** Stable React key, unique across kinds. */
  key: string
  chips: CheckScopeChip[]
  /** Sort rank: lower is more specific and comes first. */
  rank: number
}

export type CheckRow =
  | (RowBase & { kind: "project"; rule: TranslationRule })
  | (RowBase & { kind: "org"; rule: TranslationRule })
  | (RowBase & { kind: "style"; rule: StyleRule })
  | (RowBase & { kind: "builtin"; rule: TranslationRule })

export type CheckRowKind = CheckRow["kind"]

/** Most specific first. `laneOther` rows are other lanes' rules, shown last on request. */
export const CHECK_RANK = {
  laneThis: 0,
  styleNarrow: 1,
  project: 2,
  styleProjectWide: 3,
  org: 4,
  builtin: 5,
  bible: 6,
  laneOther: 7,
} as const

export interface BuildCheckRowsInput {
  /** Hand-authored project rules, every lane (useRules' `userRules`). */
  userRules: readonly TranslationRule[]
  orgRules?: readonly TranslationRule[]
  /** Built-ins as resolved for the lane being viewed. */
  builtinRules?: readonly TranslationRule[]
  /** Style rules; only `approved` ones are checks — proposals wait in review. */
  styleRules?: readonly StyleRule[]
  styleApplicability?: readonly RuleApplicability[]
  /** The lane the page is viewing (`''` = default lane). */
  viewLane: string
  /** More than one lane, or lane-scoped rules exist: show lane chips. */
  multiLane: boolean
  /** Include other lanes' rules (dashed, last). */
  showOtherLanes?: boolean
}

function projectRow(rule: TranslationRule, input: BuildCheckRowsInput): CheckRow | null {
  const relation = ruleLaneScope(rule, input.viewLane)
  if (relation === "other" && input.multiLane && !input.showOtherLanes) return null
  const chips: CheckScopeChip[] = input.multiLane
    ? [{ kind: "lane", relation, lane: rule.lane ?? "" }]
    : [{ kind: "project" }]
  const rank = !input.multiLane
    ? CHECK_RANK.project
    : relation === "this"
      ? CHECK_RANK.laneThis
      : relation === "other"
        ? CHECK_RANK.laneOther
        : CHECK_RANK.project
  return { kind: "project", key: `project:${rule.id}`, rule, chips, rank }
}

/** The chips a style rule shows: its applicability targets, else its scope. */
export function styleRuleChips(
  rule: StyleRule,
  applicability: readonly RuleApplicability[] = [],
): CheckScopeChip[] {
  const targets = applicability
    .filter((row) => row.ruleId === rule.id && row.relationship !== "excluded")
    .map((row): CheckScopeChip => ({ kind: "target", targetType: row.targetType, targetId: row.targetId }))
  if (targets.length > 0) return targets
  return rule.scope === "global" ? [{ kind: "project" }] : [{ kind: "styleScope", scope: rule.scope }]
}

function styleRow(rule: StyleRule, applicability: readonly RuleApplicability[]): CheckRow {
  const chips = styleRuleChips(rule, applicability)
  const projectWide = chips.length === 1 && chips[0].kind === "project"
  return {
    kind: "style",
    key: `style:${rule.id}`,
    rule,
    chips,
    rank: projectWide ? CHECK_RANK.styleProjectWide : CHECK_RANK.styleNarrow,
  }
}

function builtinRow(rule: TranslationRule): CheckRow {
  const bible = rule.check.type === "builtin" && isBibleCheckId(rule.check.checkId)
  return {
    kind: "builtin",
    key: `builtin:${rule.id}`,
    rule,
    chips: [{ kind: bible ? "bible" : "builtin" }],
    rank: bible ? CHECK_RANK.bible : CHECK_RANK.builtin,
  }
}

/**
 * Every check the project runs, as one list, most specific scope first.
 * Ties keep their store's own order (stable sort).
 */
export function buildCheckRows(input: BuildCheckRowsInput): CheckRow[] {
  const rows: CheckRow[] = []
  for (const rule of input.userRules) {
    const row = projectRow(rule, input)
    if (row) rows.push(row)
  }
  for (const rule of input.styleRules ?? []) {
    if (rule.status === "approved") rows.push(styleRow(rule, input.styleApplicability ?? []))
  }
  for (const rule of input.orgRules ?? []) {
    rows.push({ kind: "org", key: `org:${rule.id}`, rule, chips: [{ kind: "org" }], rank: CHECK_RANK.org })
  }
  for (const rule of input.builtinRules ?? []) rows.push(builtinRow(rule))
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.rank - b.row.rank || a.index - b.index)
    .map(({ row }) => row)
}

/** How many rows are of each kind — the pane's summary line and tests. */
export function countCheckRows(rows: readonly CheckRow[]): Record<CheckRowKind, number> {
  const counts: Record<CheckRowKind, number> = { project: 0, org: 0, style: 0, builtin: 0 }
  for (const row of rows) counts[row.kind]++
  return counts
}
