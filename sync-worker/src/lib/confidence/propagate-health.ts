// AD-14 health-as-confidence: bounded multi-hop propagation.
//
// Health = how much human authority backs a cell, decaying with each step away
// from a human-validated cell toward AI-inferred content. Confidence originates
// only at validated cells (= 100) and ripples outward through the
// example-retrieval graph, losing a `perHopDecay` factor each hop. A cell that
// relies on low-health examples ends up low-health itself; one that relies on
// validated examples (and whose translation matches them) ends up high.
//
// Pure + DB-free so it's unit-testable. The route builds the graph (FTS
// retrieval + lexical edge weights) and calls this.

/** A cell participating in propagation. Untranslated cells are NOT nodes —
 *  callers skip them (nothing to be confident about; they shouldn't drag the
 *  metric). */
export interface PropNode {
  id: string
  /** Human-validated → pinned at 100 (ground truth). */
  validated: boolean
}

/** A directed edge X→Y meaning "Y is an example X would be translated from". */
export interface PropEdge {
  to: string
  /** Source similarity (retrieval relevance) — weights the mean ("most similar"). */
  r: number
  /** Target consistency — gates how much of Y's health transfers to X. */
  a: number
}

/** nodeId → its top-k example edges. */
export type PropEdges = Map<string, PropEdge[]>

export interface PropOptions {
  /** Per-hop authority decay in (0,1]. Project-tunable; sensible default 0.8. */
  perHopDecay: number
  /** Max ripple radius (hops from a validated cell). Bounds the cascade. */
  maxHops: number
}

const VALIDATED_HEALTH = 100

/**
 * Compute each node's health (0–100) by iterating the ripple `maxHops` times.
 *
 *   health(validated) = 100
 *   health(X)         = perHopDecay × ( Σ r·a·health(Y) ) / ( Σ r )   over X's edges
 *
 * Each round reads the previous round's health, so the wavefront advances one
 * hop per iteration. Validated nodes are re-pinned to 100 every round.
 */
export function propagateHealth(
  nodes: PropNode[],
  edges: PropEdges,
  opts: PropOptions,
): Map<string, number> {
  let health = new Map<string, number>()
  for (const n of nodes) health.set(n.id, n.validated ? VALIDATED_HEALTH : 0)

  for (let hop = 0; hop < opts.maxHops; hop++) {
    const next = new Map<string, number>()
    let changed = false
    for (const n of nodes) {
      if (n.validated) {
        next.set(n.id, VALIDATED_HEALTH)
        continue
      }
      const ne = edges.get(n.id)
      let num = 0
      let den = 0
      if (ne) {
        for (const e of ne) {
          if (e.r <= 0) continue
          const hy = health.get(e.to) ?? 0
          num += e.r * e.a * hy
          den += e.r
        }
      }
      const value = den > 0 ? opts.perHopDecay * (num / den) : 0
      next.set(n.id, value)
      if (value !== (health.get(n.id) ?? 0)) changed = true
    }
    health = next
    if (!changed) break
  }
  return health
}
