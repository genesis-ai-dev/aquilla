import type { WeightedExample } from "@/lib/parsers/types"

export function ancestryPenalty(
  examples: string[] | WeightedExample[] | undefined,
  healthMap: Map<string, number>,
  cap: number,
): number {
  if (!examples || examples.length === 0) return cap
  if (typeof examples[0] === "string") return cap  // legacy, unknown weights

  const weighted = examples as WeightedExample[]
  let weightSum = 0
  let weightedHealth = 0
  for (const ex of weighted) {
    const h = healthMap.get(ex.cellId) ?? 0
    weightedHealth += h * ex.weight
    weightSum += ex.weight
  }
  if (weightSum <= 0) return cap
  const avgHealth = weightedHealth / weightSum
  return cap * (1 - avgHealth / 100)
}
