import type { ScoredPair } from "./dual-index"

export function weightedJaccard(a: ScoredPair[], b: ScoredPair[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const wA = new Map<string, number>()
  const wB = new Map<string, number>()
  for (const p of a) wA.set(p.cellId, Math.max(wA.get(p.cellId) ?? 0, p.coverageWeight))
  for (const p of b) wB.set(p.cellId, Math.max(wB.get(p.cellId) ?? 0, p.coverageWeight))

  const ids = new Set<string>([...wA.keys(), ...wB.keys()])
  let intersection = 0
  let union = 0
  for (const id of ids) {
    const va = wA.get(id) ?? 0
    const vb = wB.get(id) ?? 0
    intersection += Math.min(va, vb)
    union += Math.max(va, vb)
  }
  return union > 0 ? intersection / union : 0
}

export function weightedTokenOverlap(a: ScoredPair[], b: ScoredPair[]): number {
  if (a.length === 0 || b.length === 0) return 0

  const tokenWeights = (pairs: ScoredPair[]): Map<string, number> => {
    const w = new Map<string, number>()
    for (const p of pairs) {
      for (const t of p.matchedTokens) {
        w.set(t, (w.get(t) ?? 0) + p.coverageWeight)
      }
    }
    return w
  }

  const normalize = (w: Map<string, number>): Map<string, number> => {
    let sum = 0
    for (const v of w.values()) sum += v
    if (sum === 0) return w
    const out = new Map<string, number>()
    for (const [k, v] of w) out.set(k, v / sum)
    return out
  }

  const na = normalize(tokenWeights(a))
  const nb = normalize(tokenWeights(b))
  if (na.size === 0 || nb.size === 0) return 0

  const tokens = new Set<string>([...na.keys(), ...nb.keys()])
  let intersection = 0
  let union = 0
  for (const t of tokens) {
    const va = na.get(t) ?? 0
    const vb = nb.get(t) ?? 0
    intersection += Math.min(va, vb)
    union += Math.max(va, vb)
  }
  return union > 0 ? intersection / union : 0
}
