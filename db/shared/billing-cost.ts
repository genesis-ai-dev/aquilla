/** AQU-837: internal accounting, never customer-facing prices or units. */
export const COST_RATE_VERSION = '2026-09-cost-v1' as const
export const MICRO_UNITS_PER_UNIT = 1_000_000
/** AQU-2057: every paid call path maps to one rail (unified billing spec §2.2). */
export const COST_RAILS = ['llm', 'agent', 'jev', 'tts', 'audio', 'gpu', 'sandbox'] as const
export type CostRail = typeof COST_RAILS[number]

/** Preserve the existing approved marked-up-cent convention. */
export function costMultiplier(rail: CostRail): number {
  if (!(COST_RAILS as readonly string[]).includes(rail)) throw new Error('Unknown cost rail')
  return 4
}

export function providerCostToMicroCents(rawCostCents: number): number {
  if (!Number.isFinite(rawCostCents) || rawCostCents < 0) {
    throw new Error('Provider cost must be a known nonnegative amount')
  }
  const scaled = Math.ceil(rawCostCents * MICRO_UNITS_PER_UNIT)
  if (!Number.isSafeInteger(scaled)) throw new Error('Provider cost exceeds accounting precision')
  return scaled
}

/** Snapshot this result when admitting work; config changes cannot reprice it. */
export function quoteProviderCost(rawCostCents: number, rail: CostRail) {
  const rawMicroCents = providerCostToMicroCents(rawCostCents)
  const multiplier = costMultiplier(rail)
  const microUnits = rawMicroCents * multiplier
  if (!Number.isSafeInteger(microUnits)) throw new Error('Usage exceeds accounting precision')
  return { rateVersion: COST_RATE_VERSION, rail, multiplier, rawMicroCents, microUnits }
}

/** Missing provider cost is unresolved, not zero or an invented flat charge. */
export function readProviderCostCents(response: unknown): number {
  const usage = (response as { usage?: { cost?: unknown } } | null)?.usage
  const dollars = usage?.cost
  if (typeof dollars !== 'number') throw new Error('Provider cost is unavailable')
  const cents = dollars * 100
  providerCostToMicroCents(cents)
  return cents
}
