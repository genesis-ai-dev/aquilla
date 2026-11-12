/**
 * Plain-language lines for a cell's active checks (AQU-757).
 *
 * The gutter tint and the health ribbon only say that something is wrong.
 * Hover has to name the check and why it fired. Built-in integrity checks
 * and user/terminology rules all arrive as `RuleInfraction`, so one pass
 * covers every validator the cell surfaces. The name and the reason stay
 * separate: the rule engine's reason is a code, and `formatInfractionReason`
 * already returns the predicate without the check's name prepended.
 */
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { formatInfractionReason } from "./format-infraction"

export interface CellIssueLine {
  ruleId: string
  name: string
  reason: string
}

export function summarizeCellIssues(
  infractions: readonly RuleInfraction[],
  rulesById: ReadonlyMap<string, TranslationRule>,
  t: TFunction,
): CellIssueLine[] {
  return infractions.map((infraction) => {
    const rule = rulesById.get(infraction.ruleId)
    return {
      ruleId: infraction.ruleId,
      name: rule ? translateRuleName(rule, t) : infraction.ruleId,
      reason: formatInfractionReason(infraction, t),
    }
  })
}

/** One hover line: "Number integrity — Number from source missing in translation". */
export function formatCellIssueLine(line: CellIssueLine): string {
  return `${line.name} — ${line.reason}`
}
