import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { checkRulesForCell, ruleSourceGateMatches } from "./rule-engine"

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
 * AQU-2654: the term rules that can possibly infract on THIS cell, narrowed by
 * the source-side gate every terminology rule carries.
 *
 * Both compiled terminology shapes only fire on a cell whose source bears the
 * concept, so a rule that fails the gate cannot produce an infraction here and
 * is dropped. The gate reads the cell's SOURCE text, which does not change
 * while the user types in the target — so callers compute this once per cell
 * and reuse it across keystrokes instead of re-scanning the whole termbase on
 * every live-check tick.
 *
 * On a 664-concept termbase with affix matching on (BibleProject French), this
 * takes 1328 candidate rules down to ~2, turning a ~32 ms per-keystroke regex
 * sweep into ~0.03 ms. The output of `computeLiveTermInfractions` is unchanged:
 * dropping a rule that cannot infract removes no infraction.
 */
export function selectSourceApplicableTermRules(
  cell: CellData,
  termRules: TranslationRule[],
): TranslationRule[] {
  if (termRules.length === 0) return termRules
  return termRules.filter((rule) => ruleSourceGateMatches(rule, cell))
}

/**
 * Terminology violations computed off the LIVE editor buffer. Promotes an
 * "empty" status to "unvalidated" whenever the buffer has content, because
 * `checkRulesForCell` short-circuits on an empty target and would otherwise
 * never run the term rules against just-typed text.
 *
 * Pass `termRules` already narrowed by `selectSourceApplicableTermRules` — the
 * hot path must not re-scan the whole termbase's source patterns per keystroke
 * (AQU-2654).
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
