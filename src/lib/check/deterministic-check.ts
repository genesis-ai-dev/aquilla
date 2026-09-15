/**
 * Deterministic "Check file" pass — Phase 0.5 of the agentic-harness strategy
 * (docs/superpowers/specs/agentic-harness-strategy.md §4 `check-chapter`,
 * deterministic pass only).
 *
 * Pure functions, no network, no LLM. Two scans over the scoped cells:
 *
 *  1. Rule violations — `checkRulesForCell` over every scoped cell using the
 *     project's enabled NON-terminology rules. Terminology-compiled rules
 *     (id `term:…`) are excluded here because scan #2 covers the same
 *     concepts with per-concept occurrence aggregation; including both would
 *     double-report every miss.
 *
 *  2. Term consistency — for each active concept whose source form matches a
 *     cell's source text (shared matcher in lib/terminology/match.ts), flag
 *     cells whose target lacks ALL approved (preferred/admitted) renderings.
 *     Findings are grouped by concept so they read
 *     "Χριστός: 14 of 18 occurrences use 'Kristo', 4 use something else."
 *     The scan itself lives in `term-consistency-scan.ts` (re-exported below)
 *     so the Agent API's term-consistency read runs the same code — AQU-1231.
 *
 * Glosser drift is deferred (stretch goal in the spec): the bt-glosser builds
 * its alignment model from validated pairs at run time and a deterministic
 * "drift" verdict isn't specified yet.
 *
 * Findings are session-local; callers hold the result in component state.
 */

import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { scanTermConsistency } from "@/lib/check/term-consistency-scan"
import type { TermConsistencyFinding } from "@/lib/check/term-consistency-scan"
import type { Concept } from "@/lib/terminology/types"

// The term scan and its types live in the alias-free leaf module so
// sync-worker can import them too (AQU-1231). Re-exported here because this
// module has always been their public home for in-app callers.
export { scanTermConsistency } from "@/lib/check/term-consistency-scan"
export type {
  CheckableCell,
  CheckableConcept,
  RenderingUsage,
  TermConsistencyFinding,
} from "@/lib/check/term-consistency-scan"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One rule with every cell that breaks it (grouped for card rendering). */
export interface RuleFindingGroup {
  rule: TranslationRule
  infractions: RuleInfraction[]
}

export interface CheckRunResult {
  /** ISO timestamp of when the run finished. */
  ranAt: string
  fileId: string | null
  /** What was checked — the summary line per spec §8. */
  checkedCellCount: number
  checkedRuleCount: number
  checkedTermCount: number
  ruleFindings: RuleFindingGroup[]
  termFindings: TermConsistencyFinding[]
  /** Total issue count: infraction rows + flagged term cells. */
  totalFindingCount: number
}

// ---------------------------------------------------------------------------
// Rule pass (pure, synchronous per cell)
// ---------------------------------------------------------------------------

/** Enabled, non-terminology rules — the rule pass's working set. */
export function checkableRules(rules: readonly TranslationRule[]): TranslationRule[] {
  return rules.filter((r) => r.enabled && !r.id.startsWith("term:"))
}

/** Group flat infractions by rule for card rendering. Preserves rule order. */
export function groupInfractionsByRule(
  infractions: readonly RuleInfraction[],
  rules: readonly TranslationRule[],
): RuleFindingGroup[] {
  const byRule = new Map<string, RuleInfraction[]>()
  for (const inf of infractions) {
    const list = byRule.get(inf.ruleId)
    if (list) list.push(inf)
    else byRule.set(inf.ruleId, [inf])
  }
  const groups: RuleFindingGroup[] = []
  for (const rule of rules) {
    const list = byRule.get(rule.id)
    if (list && list.length > 0) groups.push({ rule, infractions: list })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Full run (chunked so hundreds of cells never block a frame)
// ---------------------------------------------------------------------------

export interface CheckRunInput {
  fileId: string | null
  cells: readonly CellData[]
  /** Full rule list (enabled flags respected; `term:` rules excluded here). */
  rules: readonly TranslationRule[]
  /** Project term base; only `active` concepts are scanned. */
  concepts: readonly Concept[]
}

const CHUNK_SIZE = 100

/** Yield to the event loop between chunks so the UI stays responsive. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Run the full deterministic check. Async only for chunked yielding — there
 * is no I/O. Safe to call with hundreds of cells.
 */
export async function runDeterministicCheck(
  input: CheckRunInput,
): Promise<CheckRunResult> {
  const enabledRules = checkableRules(input.rules)
  const activeConcepts = input.concepts.filter((c) => c.status === "active")

  // Rule pass, chunked.
  const infractions: RuleInfraction[] = []
  for (let i = 0; i < input.cells.length; i += CHUNK_SIZE) {
    const chunk = input.cells.slice(i, i + CHUNK_SIZE)
    for (const cell of chunk) {
      infractions.push(...checkRulesForCell(cell, cell.fileId, enabledRules))
    }
    if (i + CHUNK_SIZE < input.cells.length) await nextTick()
  }

  // Term pass (regex over short strings; one pass is cheap, but yield first
  // so the rule pass's last chunk paints).
  await nextTick()
  const termFindings = scanTermConsistency(input.cells, activeConcepts)

  const flaggedTermCells = termFindings.reduce(
    (n, f) => n + f.flaggedCells.length,
    0,
  )

  return {
    ranAt: new Date().toISOString(),
    fileId: input.fileId,
    checkedCellCount: input.cells.length,
    checkedRuleCount: enabledRules.length,
    checkedTermCount: activeConcepts.length,
    ruleFindings: groupInfractionsByRule(infractions, enabledRules),
    termFindings,
    totalFindingCount: infractions.length + flaggedTermCells,
  }
}
