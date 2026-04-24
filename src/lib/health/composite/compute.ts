import type {
  HealthConfig, TranslationRule, RuleInfraction, CellHealthBreakdown, WeightedExample,
} from "@/lib/parsers/types"
import type { ScoredPair } from "@/lib/search/dual-index"
import { weightedJaccard, weightedTokenOverlap } from "@/lib/search/dual-index-overlap"
import { validationGap } from "./validation-gap"
import { ancestryPenalty } from "./ancestry-penalty"
import { neighborhoodPenalty } from "./neighborhood-penalty"
import { rulePenalty } from "./rule-penalty"

export interface CompositeCell {
  id: string
  fileId: string
  translated: string
  validatorCount: number
  examples?: string[] | WeightedExample[]
  infractions: RuleInfraction[]
  branchingSource: ScoredPair[]
  branchingTarget: ScoredPair[]
  plainSource: ScoredPair[]
  plainTarget: ScoredPair[]
}

export interface CompositeInput {
  cells: CompositeCell[]
  rules: TranslationRule[]
  config: HealthConfig
  requiredValidations: number
}

export interface CompositeOutput {
  healthMap: Map<string, number>
  breakdownMap: Map<string, CellHealthBreakdown>
  fileHealth: Map<string, number>
  projectHealth: number
}

const MAX_ANCESTRY_ITERATIONS = 3

/**
 * Compute one cell's composite health using the provided `peerHealth` map
 * for ancestry lookups. Pure: takes the snapshot it needs, returns the score
 * plus breakdown, doesn't mutate. Callers that want the fixed-point
 * relaxation (project-wide compute) iterate this; incremental callers
 * (HealthStore) run it once per changed cell and accept that ancestry drift
 * will catch up on the next direct touch — the spreadsheet model, where
 * each cell is what it was last computed to be.
 */
export function computeOneCellHealth(
  cell: CompositeCell,
  rules: TranslationRule[],
  config: HealthConfig,
  requiredValidations: number,
  peerHealth: Map<string, number>,
): { score: number; breakdown: CellHealthBreakdown } {
  const vg = validationGap(cell.validatorCount, requiredValidations, config.caps.validationGap)
  const ap = ancestryPenalty(cell.examples, peerHealth, config.caps.ancestryPenalty)
  const tfidfOverlap = weightedTokenOverlap(cell.branchingSource, cell.branchingTarget)
  const idJaccard = weightedJaccard(cell.plainSource, cell.plainTarget)
  const np = neighborhoodPenalty({
    branchingSource: cell.branchingSource,
    branchingTarget: cell.branchingTarget,
    plainSource: cell.plainSource,
    plainTarget: cell.plainTarget,
    weights: config.neighborhoodWeights,
    cap: config.caps.neighborhoodPenalty,
  })
  const rp = rulePenalty(cell.infractions, rules, config.rulePenalties, config.caps.rulePenalty)
  const rawScore = 100 - vg - ap - np - rp
  const score = Math.max(0, Math.min(100, Math.round(rawScore)))
  const breakdown = buildBreakdown(
    cell, vg, ap, np, rp, score, peerHealth,
    requiredValidations, idJaccard, tfidfOverlap,
  )
  return { score, breakdown }
}

export function computeCompositeHealth(input: CompositeInput): CompositeOutput {
  const healthMap = new Map<string, number>()
  const breakdownMap = new Map<string, CellHealthBreakdown>()

  const active = input.cells.filter((c) => c.translated && c.translated.trim())

  // Iterated relaxation: ancestry references stabilize as parent scores settle.
  for (let iter = 0; iter < MAX_ANCESTRY_ITERATIONS; iter++) {
    let changed = false

    for (const cell of active) {
      const { score, breakdown } = computeOneCellHealth(
        cell, input.rules, input.config, input.requiredValidations, healthMap,
      )
      const prev = healthMap.get(cell.id)
      if (prev !== score) {
        healthMap.set(cell.id, score)
        changed = true
      }
      breakdownMap.set(cell.id, breakdown)
    }

    if (!changed) break
  }

  const fileBuckets = new Map<string, number[]>()
  for (const cell of active) {
    const h = healthMap.get(cell.id)
    if (h === undefined) continue
    let bucket = fileBuckets.get(cell.fileId)
    if (!bucket) { bucket = []; fileBuckets.set(cell.fileId, bucket) }
    bucket.push(h)
  }
  const fileHealth = new Map<string, number>()
  let projectSum = 0, projectCount = 0
  for (const [fid, bucket] of fileBuckets) {
    const sum = bucket.reduce((a, b) => a + b, 0)
    fileHealth.set(fid, bucket.length > 0 ? Math.round(sum / bucket.length) : 0)
    projectSum += sum
    projectCount += bucket.length
  }
  const projectHealth = projectCount > 0 ? Math.round(projectSum / projectCount) : 0

  return { healthMap, breakdownMap, fileHealth, projectHealth }
}

function buildBreakdown(
  cell: CompositeCell,
  vg: number, ap: number, np: number, rp: number,
  score: number,
  healthMap: Map<string, number>,
  requiredValidations: number,
  idJaccard: number,
  tfidfOverlap: number,
): CellHealthBreakdown {
  const isWeighted = cell.examples && cell.examples.length > 0 && typeof cell.examples[0] !== "string"
  const ancestryExamples = isWeighted
    ? (cell.examples as WeightedExample[]).map((e) => ({
        cellId: e.cellId, health: healthMap.get(e.cellId) ?? 0, weight: e.weight,
      }))
    : []

  return {
    cellId: cell.id,
    score,
    validationGap: Math.round(vg),
    ancestryPenalty: Math.round(ap),
    neighborhoodPenalty: Math.round(np),
    rulePenalty: Math.round(rp),
    signals: {
      validatorCount: cell.validatorCount,
      requiredValidations,
      ancestryExamples,
      neighborhoodSourceCellIds: cell.branchingSource.map((p) => p.cellId),
      neighborhoodTargetCellIds: cell.branchingTarget.map((p) => p.cellId),
      idJaccard,
      tfidfTokenOverlap: tfidfOverlap,
      infractions: cell.infractions,
    },
  }
}
