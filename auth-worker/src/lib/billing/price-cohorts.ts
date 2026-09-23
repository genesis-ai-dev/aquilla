export interface PriceExperiment {
  key: string
  enabled: boolean
  variants: readonly { key: string; priceVersion: string; weight: number }[]
}
export interface PriceCohort {
  org_id: number
  experiment_key: string
  variant: string
  price_version: string
  assigned_at: string
  exposed_at: string | null
}
export function readPriceCohort(db: AquillaDb, orgId: number, experiment: string) {
  return db.prepare(`SELECT org_id, experiment_key, variant, price_version,
    assigned_at::text, exposed_at::text FROM billing_price_cohorts
    WHERE org_id = ? AND experiment_key = ?`)
    .bind(orgId, experiment).first<PriceCohort>()
}
/** Eligibility must come from server billing state, never browser input. */
export async function assignPriceCohort(
  db: AquillaDb, orgId: number, experiment: PriceExperiment, eligible: boolean,
): Promise<PriceCohort | null> {
  if (!Number.isSafeInteger(orgId) || orgId < 1) throw new Error('Invalid workspace')
  const current = await readPriceCohort(db, orgId, experiment.key)
  if (current) return current
  if (!experiment.enabled || !eligible) return null
  const variants = experiment.variants
  if (!experiment.key || !variants.length
    || new Set(variants.map(v => v.key)).size !== variants.length
    || variants.some(v => !v.key || !v.priceVersion
      || !Number.isSafeInteger(v.weight) || v.weight < 0)
    || variants.reduce((sum, v) => sum + v.weight, 0) !== 10000) {
    throw new Error('Invalid pricing experiment')
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    `${experiment.key}:${orgId}`,
  ))
  let bucket = new DataView(digest).getUint32(0) % 10000
  const selected = variants.find(variant => {
    if (bucket < variant.weight) return true
    bucket -= variant.weight
    return false
  })!
  await db.prepare(`INSERT INTO billing_price_cohorts
    (org_id, experiment_key, variant, price_version)
    VALUES (?, ?, ?, ?) ON CONFLICT (org_id, experiment_key) DO NOTHING`)
    .bind(orgId, experiment.key, selected.key, selected.priceVersion).run()
  // Another request may have won. Always use the persisted assignment.
  const result = await readPriceCohort(db, orgId, experiment.key)
  if (!result) throw new Error('Pricing assignment was not persisted')
  return result
}
/** Record exposure after the offer renders, not when it is fetched or assigned. */
export async function recordPricingExposure(
  db: AquillaDb, orgId: number, experiment: string, priceVersion: string,
): Promise<boolean> {
  const changed = await db.prepare(`UPDATE billing_price_cohorts
    SET exposed_at = now()
    WHERE org_id = ? AND experiment_key = ? AND price_version = ?
      AND exposed_at IS NULL RETURNING org_id`)
    .bind(orgId, experiment, priceVersion).first<{ org_id: number }>()
  return changed !== null
}
