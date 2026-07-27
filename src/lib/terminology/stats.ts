/**
 * Terminology library statistics — derived on read, no new persistence.
 *
 * Given a list of Concept[] and cell data (source + target text pairs),
 * computes per-concept and aggregate enforcement/infringement statistics.
 *
 * Semantics reuse compile.ts rule logic directly (same regex patterns) so
 * there is no divergence between what the rule-engine flags and what is
 * counted here.
 *
 * Definitions:
 *   ENFORCED  — source contains the sourceTerm AND target contains at least one
 *               approved (preferred | admitted) rendering.
 *   INFRINGED — source contains the sourceTerm AND (no approved rendering in
 *               target OR a forbidden rendering is present in target).
 *   N/A       — source does not contain the sourceTerm (concept not triggered).
 *
 * Only `active` concepts are evaluated. Draft / deprecated concepts are skipped
 * (matching compile.ts behaviour).
 */

import type { Concept } from "./types"
import { effectiveSourceText } from "@/lib/cell-text"

// ────────────────────────────────────────────────────────────────────────────
// Cell pair input shape (a minimal subset of CellData)
// ────────────────────────────────────────────────────────────────────────────

export interface CellPair {
  /** Source text (original). */
  original: string
  /** Target text (translation). */
  translated: string
  // SUB-28: media sections match against their transcript, not the filename.
  medium?: import("@/lib/sync/cells-read-types").SegmentMedium | null
  transcription?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Per-concept stats
// ────────────────────────────────────────────────────────────────────────────

export interface ConceptStats {
  conceptId: string
  sourceTerm: string
  /** Number of cells where the source term is present. */
  occurrences: number
  /** Cells where term is present AND an approved rendering is in the target. */
  enforced: number
  /** Cells where term is present AND no approved rendering OR a forbidden
   *  rendering is found in the target. */
  infringed: number
  /** infringed / occurrences, or 0 when occurrences === 0. */
  infringedRate: number
}

// ────────────────────────────────────────────────────────────────────────────
// Aggregate stats
// ────────────────────────────────────────────────────────────────────────────

export interface TerminologyStats {
  /** Total active concepts evaluated. */
  totalConcepts: number
  /** Total cells provided for analysis. */
  totalCells: number
  /**
   * Percentage (0–100) of concept-cell occurrences that are ENFORCED.
   * 0 when no occurrences exist.
   */
  enforcedPct: number
  /**
   * Percentage (0–100) of concept-cell occurrences that are INFRINGED.
   * 0 when no occurrences exist. A genuinely clean project yields 0.
   */
  infringedPct: number
  /** Per-concept breakdown for all active concepts. */
  byConcept: ConceptStats[]
  /** Top-5 most-infringed concepts, descending by infringed count. */
  top5Infringed: ConceptStats[]
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers (mirror compile.ts escapeRegex + pattern construction)
// ────────────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Build a whole-word, case-insensitive RegExp for a term. */
function termRegex(term: string): RegExp {
  return new RegExp(`\\b${escapeRegex(term)}\\b`, "i")
}

/**
 * Evaluate one concept against one cell pair.
 *
 * Returns:
 *   'enforced'  — source has term, target has an approved rendering.
 *   'infringed' — source has term, target lacks approved OR has forbidden.
 *   'na'        — source does not contain the term (concept not triggered).
 */
function evaluateCell(
  concept: Concept,
  cell: CellPair,
): "enforced" | "infringed" | "na" {
  const sourceRe = termRegex(concept.sourceTerm)
  if (!sourceRe.test(effectiveSourceText(cell))) return "na"

  const approved = concept.renderings.filter(
    (r) => r.status === "preferred" || r.status === "admitted",
  )
  const forbidden = concept.renderings.filter((r) => r.status === "forbidden")

  // Check for any forbidden rendering in target.
  const hasForbidden = forbidden.some((f) =>
    termRegex(f.rendering).test(cell.translated),
  )
  if (hasForbidden) return "infringed"

  // When the concept has approved renderings, at least one must be present.
  if (approved.length > 0) {
    const hasApproved = approved.some((a) =>
      termRegex(a.rendering).test(cell.translated),
    )
    return hasApproved ? "enforced" : "infringed"
  }

  // Concept has only forbidden renderings and none appeared → treat as enforced
  // (no positive requirement was violated; forbidden check already passed).
  return "enforced"
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute terminology library statistics derived purely from the supplied
 * concepts and cell pairs. No I/O; safe to call in a `useMemo`.
 *
 * Only `active` concepts are included. An empty cells array yields 0% for all
 * rates. A genuinely-clean project (every occurrence uses an approved rendering,
 * no forbidden renderings present) yields infringedPct = 0.
 */
export function computeTerminologyStats(
  concepts: Concept[],
  cells: CellPair[],
): TerminologyStats {
  const active = concepts.filter((c) => c.status === "active")

  let totalOccurrences = 0
  let totalEnforced = 0
  let totalInfringed = 0

  const byConcept: ConceptStats[] = active.map((concept) => {
    let occurrences = 0
    let enforced = 0
    let infringed = 0

    for (const cell of cells) {
      const result = evaluateCell(concept, cell)
      if (result === "na") continue
      occurrences++
      if (result === "enforced") enforced++
      else infringed++
    }

    totalOccurrences += occurrences
    totalEnforced += enforced
    totalInfringed += infringed

    return {
      conceptId: concept.id,
      sourceTerm: concept.sourceTerm,
      occurrences,
      enforced,
      infringed,
      infringedRate: occurrences > 0 ? infringed / occurrences : 0,
    }
  })

  const enforcedPct =
    totalOccurrences > 0 ? (totalEnforced / totalOccurrences) * 100 : 0
  const infringedPct =
    totalOccurrences > 0 ? (totalInfringed / totalOccurrences) * 100 : 0

  // Top-5 most infringed: sort descending by infringed count, then by rate.
  const top5Infringed = byConcept
    .filter((s) => s.infringed > 0)
    .sort((a, b) =>
      b.infringed !== a.infringed
        ? b.infringed - a.infringed
        : b.infringedRate - a.infringedRate,
    )
    .slice(0, 5)

  return {
    totalConcepts: active.length,
    totalCells: cells.length,
    enforcedPct,
    infringedPct,
    byConcept,
    top5Infringed,
  }
}
