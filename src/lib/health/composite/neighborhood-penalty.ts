import type { NeighborhoodWeights } from "@/lib/parsers/types"
import type { ScoredPair } from "@/lib/search/dual-index"
import { weightedJaccard, weightedTokenOverlap } from "@/lib/search/dual-index-overlap"

export interface NeighborhoodInput {
  branchingSource: ScoredPair[]
  branchingTarget: ScoredPair[]
  plainSource: ScoredPair[]
  plainTarget: ScoredPair[]
  weights: NeighborhoodWeights
  cap: number
}

export function neighborhoodPenalty(i: NeighborhoodInput): number {
  const tfidf = weightedTokenOverlap(i.branchingSource, i.branchingTarget)
  const jac = weightedJaccard(i.plainSource, i.plainTarget)

  const wId = Math.max(0, i.weights.idJaccard)
  const wTf = Math.max(0, i.weights.tfidfTokenOverlap)
  const total = wId + wTf
  const blend = total > 0 ? (wId * jac + wTf * tfidf) / total : 0

  return i.cap * (1 - blend)
}
