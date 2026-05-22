// AD-14 decay / health engine.
//
// Replaces the prior four-sub-score "composite" health model. The metric is
// the same number framed two ways (foundations CP-6 / AD-14):
//   - cell scope  → "decay": how far a cell is from a validated neighborhood.
//   - file/project → "health": 1 - mean(decay). A target to optimize toward.
//
// Decay is derived purely from each cell's `endorsement_count` projection
// (driven server-side by validation → branching-search → endorsement, AD-13/14).
// Rule/check violations are a SEPARATE sibling surface and are NOT folded in
// here (AD-14: "rules and built-in checks stay separate").

import type { CellData } from "@/hooks/useCells"

/** Endorsements at which a cell reaches decay = 0 (project_settings default). */
export const DEFAULT_ENDORSEMENT_TARGET = 5
/** Decay above which the cell editor shows a "needs attention" marker. */
export const DEFAULT_DECAY_WARN_THRESHOLD = 0.66

export interface DecayConfig {
  endorsementTarget: number
  decayWarnThreshold: number
}

export const DECAY_DEFAULTS: DecayConfig = {
  endorsementTarget: DEFAULT_ENDORSEMENT_TARGET,
  decayWarnThreshold: DEFAULT_DECAY_WARN_THRESHOLD,
}

/** AD-14: decay(cell) = max(0, 1 - endorsement_count / N). */
export function cellDecay(
  endorsementCount: number,
  endorsementTarget: number = DEFAULT_ENDORSEMENT_TARGET,
): number {
  if (endorsementTarget <= 0) return 0
  return Math.max(0, 1 - endorsementCount / endorsementTarget)
}

/** Per-cell health 0-100 = round((1 - decay) * 100). */
export function cellHealth(
  endorsementCount: number,
  endorsementTarget: number = DEFAULT_ENDORSEMENT_TARGET,
): number {
  return Math.round((1 - cellDecay(endorsementCount, endorsementTarget)) * 100)
}

/**
 * AD-14: a cell shows the inline "needs attention" marker iff its decay is
 * strictly above the warn threshold. Absence of the marker is silence, NOT
 * endorsement — there is no green "done" affordance at cell scope.
 */
export function needsAttention(
  endorsementCount: number,
  settings: DecayConfig = DECAY_DEFAULTS,
): boolean {
  return cellDecay(endorsementCount, settings.endorsementTarget) > settings.decayWarnThreshold
}

export interface DecayHealth {
  /** cellId → per-cell health 0-100 (1 - decay). */
  healthMap: Map<string, number>
  /** fileId → health 0-100 = (1 - mean(decay over the file's cells)). */
  fileHealth: Map<string, number>
  /** Overall health 0-100 = (1 - mean(decay over every cell)). */
  projectHealth: number
}

/**
 * Compute decay-derived health across all files. Every cell counts, including
 * untouched ones (endorsement_count 0 → decay 1) — a freshly imported book
 * reads near-zero health and climbs as translators validate (AD-14).
 */
export function computeDecayHealth(
  fileCells: Map<string, CellData[]>,
  settings: DecayConfig = DECAY_DEFAULTS,
): DecayHealth {
  const healthMap = new Map<string, number>()
  const fileHealth = new Map<string, number>()
  let projectDecaySum = 0
  let projectCount = 0

  for (const [fileId, cells] of fileCells) {
    let fileDecaySum = 0
    for (const cell of cells) {
      const d = cellDecay(cell.endorsementCount ?? 0, settings.endorsementTarget)
      healthMap.set(cell.id, Math.round((1 - d) * 100))
      fileDecaySum += d
    }
    fileHealth.set(
      fileId,
      cells.length > 0 ? Math.round((1 - fileDecaySum / cells.length) * 100) : 0,
    )
    projectDecaySum += fileDecaySum
    projectCount += cells.length
  }

  const projectHealth =
    projectCount > 0 ? Math.round((1 - projectDecaySum / projectCount) * 100) : 0
  return { healthMap, fileHealth, projectHealth }
}
