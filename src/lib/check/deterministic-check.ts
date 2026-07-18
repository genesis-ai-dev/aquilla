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
import { buildTermRegex } from "@/lib/terminology/match"
import type { Concept } from "@/lib/terminology/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal cell shape the scans need — keeps the scan testable without
 *  constructing full CellData fixtures. */
export interface CheckableCell {
  id: string
  /** Human-facing reference ("MAT 1:1"); falls back to id in the UI. */
  cellLabel?: string
  original: string
  translated: string
  status: CellData["status"]
}

/** One rule with every cell that breaks it (grouped for card rendering). */
export interface RuleFindingGroup {
  rule: TranslationRule
  infractions: RuleInfraction[]
}

/** How many flagged-scope cells used one approved rendering. */
export interface RenderingUsage {
  rendering: string
  /** Cells (by id) whose target contains this rendering. */
  cellIds: string[]
}

/** Per-concept consistency result over the scoped cells. */
export interface TermConsistencyFinding {
  conceptId: string
  sourceTerm: string
  /** Approved renderings (preferred + admitted), for evidence display. */
  approvedRenderings: string[]
  /** Translated cells whose SOURCE matches the concept's source form. */
  totalOccurrences: number
  /** Occurrences whose target contains at least one approved rendering. */
  consistentCount: number
  /** Usage per approved rendering (a cell may count toward several). */
  renderingUsage: RenderingUsage[]
  /** Occurrences whose target contains NONE of the approved renderings. */
  flaggedCells: { cellId: string; cellLabel?: string }[]
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
// Term-consistency scan (pure, synchronous)
// ---------------------------------------------------------------------------

/**
 * Scan scoped cells for term consistency against active concepts.
 *
 * Only translated cells participate (an empty target is "not translated yet",
 * not a term inconsistency — mirrors the rule engine's empty short-circuit).
 * Concepts with no approved renderings produce no finding: there is nothing
 * the target could be checked against.
 *
 * Returns one finding per concept that has ≥1 occurrence, in concept order.
 * Callers typically render only findings with flaggedCells.length > 0 but the
 * fully-consistent ones are returned too so the UI can say "14 of 14".
 */
export function scanTermConsistency(
  cells: readonly CheckableCell[],
  concepts: readonly Concept[],
): TermConsistencyFinding[] {
  const findings: TermConsistencyFinding[] = []

  for (const concept of concepts) {
    if (concept.status !== "active") continue
    const sourceRe = buildTermRegex(concept.sourceTerm)
    if (!sourceRe) continue

    const approved = concept.renderings.filter(
      (r) => r.status === "preferred" || r.status === "admitted",
    )
    if (approved.length === 0) continue

    const approvedRes = approved
      .map((r) => ({ rendering: r.rendering, re: buildTermRegex(r.rendering) }))
      .filter((x): x is { rendering: string; re: RegExp } => x.re !== null)
    if (approvedRes.length === 0) continue

    let totalOccurrences = 0
    let consistentCount = 0
    const usage = new Map<string, string[]>()
    const flaggedCells: TermConsistencyFinding["flaggedCells"] = []

    for (const cell of cells) {
      if (cell.status === "empty" || !cell.translated.trim()) continue
      if (!sourceRe.test(cell.original)) continue
      totalOccurrences++

      let matchedAny = false
      for (const { rendering, re } of approvedRes) {
        if (re.test(cell.translated)) {
          matchedAny = true
          const list = usage.get(rendering)
          if (list) list.push(cell.id)
          else usage.set(rendering, [cell.id])
        }
      }
      if (matchedAny) consistentCount++
      else flaggedCells.push({ cellId: cell.id, cellLabel: cell.cellLabel })
    }

    if (totalOccurrences === 0) continue
    findings.push({
      conceptId: concept.id,
      sourceTerm: concept.sourceTerm,
      approvedRenderings: approvedRes.map((x) => x.rendering),
      totalOccurrences,
      consistentCount,
      renderingUsage: [...usage.entries()].map(([rendering, cellIds]) => ({
        rendering,
        cellIds,
      })),
      flaggedCells,
    })
  }

  return findings
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
