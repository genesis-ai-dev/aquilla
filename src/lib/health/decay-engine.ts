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

import type { RuleInfraction, DecaySettings } from "@/lib/parsers/types"

/**
 * The shape returned by `useHealth`. Health numbers come from decay (AD-14);
 * rule infractions, file progress, and open-comment counts are sibling
 * surfaces carried alongside (NOT folded into health).
 */
export interface HealthStats {
  /** cellId → per-cell health 0-100 (1 - decay). */
  healthMap: Map<string, number>
  /** fileId → file health 0-100. */
  fileHealth: Map<string, number>
  /** Overall project health 0-100. */
  projectHealth: number
  fileProgress: Map<string, { translated: number; validated: number; total: number }>
  /** Rule / built-in-check violations — separate sibling surface (AD-14). */
  infractions: Map<string, RuleInfraction[]>
  openCommentCount: Map<string, number>
  projectOpenCommentCount: number
  cellOpenCommentCount: Map<string, number>
}

/**
 * Pure-function fallback endorsement target, used ONLY when no project context
 * is available. At runtime the effective target comes from `resolveDecayConfig`
 * — it defaults to the project's required-validations gate, NOT this constant.
 * The neighborhood-propagation loop that would grow endorsement_count past raw
 * validator counts (AD-13/14) is not yet built, so tying the target to the
 * validation gate is what makes a validated cell actually reach full health.
 */
export const DEFAULT_ENDORSEMENT_TARGET = 5
/** Decay above which the cell editor shows a "needs attention" marker. */
export const DEFAULT_DECAY_WARN_THRESHOLD = 0.66

/**
 * AQU-232: user-visible status text shown in the cell popover when a cell
 * needs attention due to insufficient validation in its passage context.
 * Single source of truth — tested in decay-engine.test.ts.
 */
export const CELL_NEEDS_ATTENTION_STATUS =
  "This cell's passage context hasn't been validated yet."

export interface DecayConfig {
  endorsementTarget: number
  decayWarnThreshold: number
}

export const DECAY_DEFAULTS: DecayConfig = {
  endorsementTarget: DEFAULT_ENDORSEMENT_TARGET,
  decayWarnThreshold: DEFAULT_DECAY_WARN_THRESHOLD,
}

/**
 * Resolve the decay config that should actually be used for a project.
 *
 * The endorsement target defaults to the project's required-validations gate
 * (`requiredValidations`, always >= 1) so that a cell which has met its
 * validation requirement reaches decay 0 / full health. An explicit
 * `decaySettings.endorsementTarget` overrides the gate when a project has
 * deliberately tuned it. This replaces the prior behavior of comparing
 * endorsement_count against a hard-coded 5, which left validated cells stuck
 * near 20% health because the AD-13/14 neighborhood-propagation loop that was
 * meant to grow endorsement_count was never built.
 */
export function resolveDecayConfig(
  decaySettings: DecaySettings | undefined,
  requiredValidations: number,
): DecayConfig {
  const gate = requiredValidations >= 1 ? requiredValidations : 1
  const target = decaySettings?.endorsementTarget ?? gate
  return {
    endorsementTarget: target >= 1 ? target : 1,
    decayWarnThreshold: decaySettings?.decayWarnThreshold ?? DEFAULT_DECAY_WARN_THRESHOLD,
  }
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
 *
 * @deprecated Prefer `needsAttentionFromConfidence` when a server-derived
 * confidence score (0-100) is available. This overload is kept for
 * local-only projects and as a fallback while the server rollup loads.
 */
export function needsAttention(
  endorsementCount: number,
  settings: DecayConfig = DECAY_DEFAULTS,
): boolean {
  return cellDecay(endorsementCount, settings.endorsementTarget) > settings.decayWarnThreshold
}

/**
 * AD-14 amendment 2026-06-04: confidence-based "needs attention".
 * Uses a server-derived confidence score (0-100) instead of endorsement_count.
 * `decay = 1 - confidence/100`; marker shows when decay > decayWarnThreshold.
 */
export function needsAttentionFromConfidence(
  confidenceScore: number,
  decayWarnThreshold: number = DEFAULT_DECAY_WARN_THRESHOLD,
): boolean {
  const decay = 1 - confidenceScore / 100
  return decay > decayWarnThreshold
}

export interface DecayHealth {
  /** cellId → per-cell health 0-100 (1 - decay). */
  healthMap: Map<string, number>
  /** fileId → health 0-100 = (1 - mean(decay over the file's cells)). */
  fileHealth: Map<string, number>
  /** Overall health 0-100 = (1 - mean(decay over every cell)). */
  projectHealth: number
}

export interface DecayCell {
  id: string
  endorsementCount?: number
}

/**
 * Compute decay-derived health across all files. Every cell counts, including
 * untouched ones (endorsement_count 0 → decay 1) — a freshly imported book
 * reads near-zero health and climbs as translators validate (AD-14).
 */
export function computeDecayHealth(
  fileCells: Map<string, readonly DecayCell[]>,
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
