import type { AquillaDb } from '../../../../db/shim/postgres'
import { quoteOffer, type Offer, type PriceCatalog, type StripePriceInput } from './pricing-model'
import { readBillingWorkspace, readWorkspaceEntitlement } from './workspace'

/** Only for verified payment reconciliation. No client route grants entitlements. */
export async function recordInitialWorkspaceEntitlement(
  db: AquillaDb,
  input: {
    orgId: number
    catalog: PriceCatalog
    prices: readonly StripePriceInput[]
    offer: Exclude<Offer, 'free'>
    interval: 'month' | 'year'
    quantity: number
    subscriptionId: string
    customerId: string
    activatedAt: string
  },
  now = new Date(),
) {
  if (!db.transaction) throw new Error('Entitlement persistence requires transactions')
  if (!Number.isSafeInteger(input.orgId) || input.orgId < 1
    || !/^sub_[a-zA-Z0-9_]+$/.test(input.subscriptionId)
    || !/^cus_[a-zA-Z0-9_]+$/.test(input.customerId)
    || input.catalog.entitlementVersion !== '2026-09-weekly'
    || !input.catalog.version || input.quantity !== 1) {
    throw new Error('Invalid initial entitlement')
  }
  const anchor = new Date(input.activatedAt)
  if (!Number.isFinite(anchor.getTime()) || anchor > now) {
    throw new Error('Invalid activation anchor')
  }
  const quote = quoteOffer(input.catalog, input.prices, input.offer, input.interval, input.quantity)
  const ids = quote.lineItems.map(item => item.price)
  return db.transaction(async tx => {
    const org = await tx.prepare('SELECT id FROM organizations WHERE id = ? FOR UPDATE')
      .bind(input.orgId).first()
    if (!org) throw new Error('Workspace not found')
    const existing = await readWorkspaceEntitlement(tx, input.orgId)
    if (existing) {
      if (existing.stripe_subscription_id !== input.subscriptionId
        || existing.stripe_customer_id !== input.customerId
        || existing.offer !== quote.offer || existing.quantity !== quote.quantity
        || existing.price_version !== quote.priceVersion
        || existing.entitlement_version !== quote.entitlementVersion
        || existing.billing_interval !== quote.interval
        || JSON.stringify(existing.price_ids) !== JSON.stringify(ids)) {
        throw new Error('Existing entitlement changes require an approved change policy')
      }
      return existing
    }
    const workspace = await readBillingWorkspace(tx, input.orgId, now)
    if (!workspace || workspace.eligibility.reason !== 'ready'
      || !workspace.eligibility.offers.includes(quote.offer)) {
      throw new Error('Workspace is not eligible for this offer')
    }
    await tx.prepare(`INSERT INTO workspace_plan_entitlements
      (org_id, offer, scope, quantity, entitlement_version, price_version,
       price_ids, stripe_subscription_id, stripe_customer_id,
       billing_interval, usage_anchor)
      VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::timestamptz)`)
      .bind(input.orgId, quote.offer, quote.scope, quote.quantity,
        quote.entitlementVersion, quote.priceVersion, JSON.stringify(ids),
        input.subscriptionId, input.customerId, quote.interval, anchor.toISOString()).run()
    const saved = await readWorkspaceEntitlement(tx, input.orgId)
    if (!saved) throw new Error('Entitlement was not persisted')
    return saved
  })
}
