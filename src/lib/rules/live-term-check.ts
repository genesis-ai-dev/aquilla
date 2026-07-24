import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { checkRulesForCell } from "./rule-engine"

/**
 * AQU-664: live terminology-blot support.
 *
 * The inline `violation-blot-term` decoration used to appear only after the
 * ~1.2s commit-idle debounce, because terminology checks ran off the committed
 * cell content. These helpers let the editor recompute terminology violations
 * off the live (un-committed) buffer so the blot lights up as-you-type, while
 * every other rule keeps the committed cadence.
 */

/** Enabled terminology rules (id `term:…`) from a rule collection. */
export function selectTermRules(rules: Iterable<TranslationRule>): TranslationRule[] {
  return [...rules].filter((r) => r.enabled && r.id.startsWith("term:"))
}

/**
 * Terminology violations computed off the LIVE editor buffer. Promotes an
 * "empty" status to "unvalidated" whenever the buffer has content, because
 * `checkRulesForCell` short-circuits on an empty target and would otherwise
 * never run the term rules against just-typed text.
 */
export function computeLiveTermInfractions(
  cell: CellData,
  liveText: string,
  termRules: TranslationRule[],
): RuleInfraction[] {
  if (termRules.length === 0) return []
  const probe: CellData = {
    ...cell,
    translated: liveText,
    status: liveText.trim() ? "unvalidated" : cell.status,
  }
  return checkRulesForCell(probe, cell.fileId, termRules)
}

/**
 * Blot infraction set for the editor: committed non-terminology infractions
 * (unchanged cadence) plus the freshly computed live terminology ones, which
 * REPLACE the committed `term:` infractions that lag by a commit cycle.
 */
export function mergeBlotInfractions(
  committed: RuleInfraction[],
  liveTerm: RuleInfraction[],
): RuleInfraction[] {
  const nonTerm = committed.filter((i) => !i.ruleId.startsWith("term:"))
  return [...nonTerm, ...liveTerm]
}
