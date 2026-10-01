// Boundary-detection scoring for the AI section/passage eval (AQU-1387).
//
// Separate from scripts/ai-sections-eval.ts, which runs at import time, so the
// matcher can be tested directly. A scoring bug here would not fail anything —
// it would quietly report a better number than the model earned, which is the
// one failure mode an eval cannot afford.

export interface BoundaryScore {
  precision: number
  recall: number
  f1: number
  hits: number
}

/**
 * Score predicted boundary positions against true ones, matching within
 * `tolerance` cells.
 *
 * Tolerance exists because a passage suggestion that opens one verse early is
 * still usable — scoring it as a miss would understate a model a translator
 * would be happy with. Matching is greedy and ONE-TO-ONE: each true boundary
 * can be claimed once, so proposing a cluster of three guesses around one real
 * break scores a single hit and two false positives, not three hits. Without
 * that, spraying boundaries everywhere would look like perfect recall at no
 * cost to precision.
 *
 * Nearer candidates are preferred over further ones so a close pairing is never
 * given away to a boundary that had a better match available.
 */
export function scoreBoundaries(
  predicted: readonly number[],
  truth: readonly number[],
  tolerance = 1,
): BoundaryScore {
  const unclaimed = new Set(truth)
  let hits = 0
  for (const boundary of [...predicted].sort((left, right) => left - right)) {
    let claimed: number | undefined
    for (let offset = 0; offset <= tolerance && claimed === undefined; offset += 1) {
      const candidates = offset === 0 ? [boundary] : [boundary - offset, boundary + offset]
      claimed = candidates.find((candidate) => unclaimed.has(candidate))
    }
    if (claimed !== undefined) {
      unclaimed.delete(claimed)
      hits += 1
    }
  }
  const precision = predicted.length === 0 ? 0 : hits / predicted.length
  const recall = truth.length === 0 ? 0 : hits / truth.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1, hits }
}
