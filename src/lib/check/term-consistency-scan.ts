/**
 * Term-consistency scan — the pure, shared core of the deterministic
 * "Check file" pass (`deterministic-check.ts` scan #2).
 *
 * AQU-1231 extracted it here so the Agent API's term-consistency read
 * (`sync-worker/src/external/quality-routes.ts`) runs the EXACT scan the UI
 * runs, rather than a server-side reimplementation that drifts from the
 * numbers a user sees. `deterministic-check.ts` re-exports everything below,
 * so in-app callers are unaffected.
 *
 * Constraints for this file (it is reachable from `sync-worker/src/**`, whose
 * tsconfig has no path aliases):
 *   - relative imports only, and only of alias-free modules;
 *   - inputs are STRUCTURAL types, not the SPA's `CellData` / `Concept` — both
 *     of those reach `@/lib/i18n` transitively. `CellData` and `Concept`
 *     satisfy these interfaces structurally, so SPA callers pass them
 *     unchanged.
 */

import { buildTermRegex } from "../terminology/match"
import { semanticSourceText } from "../semantic-source-text"

// ---------------------------------------------------------------------------
// Structural inputs
// ---------------------------------------------------------------------------

/** Minimal cell shape the scan needs — keeps the scan testable without
 *  constructing full CellData fixtures. Satisfied structurally by `CellData`
 *  and by the sync-worker's `cells`-table row mapping. */
export interface CheckableCell {
  id: string
  /** Human-facing reference ("MAT 1:1"); falls back to id in the UI. */
  cellLabel?: string
  original: string
  translated: string
  /** `"empty"` short-circuits the scan. Server callers may omit it — an empty
   *  `translated` is skipped either way. */
  status?: string
  // SUB-28: media sections match against their transcript, not the filename.
  medium?: string | null
  transcription?: string
}

/** Minimal concept shape the scan needs. Satisfied structurally by `Concept`. */
export interface CheckableConcept {
  id: string
  sourceTerm: string
  status: string
  renderings: readonly { rendering: string; status: string }[]
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Scan (pure, synchronous)
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
  concepts: readonly CheckableConcept[],
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
      if (!sourceRe.test(semanticSourceText(cell))) continue
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
