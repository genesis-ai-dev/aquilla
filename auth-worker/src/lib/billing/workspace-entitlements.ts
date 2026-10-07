import type { AquillaDb } from '../../../../db/shim/postgres'
import { quoteOffer, type Offer, type PriceCatalog, type StripePriceInput } from './pricing-model'
import { readBillingWorkspace, readWorkspaceEntitlement } from './workspace'

/** Requires a transaction-bound handle. No client route grants entitlements. */
export async function recordInitialWorkspaceEntitlementInTransaction(
  tx: AquillaDb,
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
    paidThrough?: string
  },
  now = new Date(),
) {
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
  // Bind serialized JSON as text first: postgres.js otherwise encodes it twice.
  await tx.prepare(`INSERT INTO workspace_plan_entitlements
    (org_id, offer, scope, quantity, entitlement_version, price_version,
     price_ids, stripe_subscription_id, stripe_customer_id,
     billing_interval, usage_anchor)
    VALUES (?, ?, ?, ?, ?, ?, ?::text::jsonb, ?, ?, ?, ?::timestamptz)`)
    .bind(input.orgId, quote.offer, quote.scope, quote.quantity,
      quote.entitlementVersion, quote.priceVersion, JSON.stringify(ids),
      input.subscriptionId, input.customerId, quote.interval, anchor.toISOString()).run()
  if (input.paidThrough) {
    const end = new Date(input.paidThrough)
    if (!Number.isFinite(end.getTime()) || end <= anchor) throw new Error('Invalid paid period')
    await tx.prepare(`INSERT INTO workspace_subscription_state
      (org_id, payment_failed, paid_through, cancel_at_period_end)
      VALUES (?, false, ?::timestamptz, false)`)
      .bind(input.orgId, end.toISOString()).run()
  }
  const saved = await readWorkspaceEntitlement(tx, input.orgId)
  if (!saved) throw new Error('Entitlement was not persisted')
  return saved
}

/** Standalone entry point; webhook callers use their existing receipt transaction. */
export async function recordInitialWorkspaceEntitlement(
  db: AquillaDb,
  input: Parameters<typeof recordInitialWorkspaceEntitlementInTransaction>[1],
  now = new Date(),
) {
  if (!db.transaction) throw new Error('Entitlement persistence requires transactions')
  return db.transaction(tx => recordInitialWorkspaceEntitlementInTransaction(tx, input, now))
}
