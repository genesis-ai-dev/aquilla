import { z } from 'zod'
import type { Env } from '../../types'
import type { BillingChangeReview } from '../../../../db/shared/billing-change-review'
import { readValidatedBillingCatalog, priceSchema } from './catalog'
import { paidOffers } from './catalog-view'
import { quoteOffer, weeklyAllowance, weeklyUsagePeriod } from './pricing-model'
import { stripeForm } from './stripe'
import { readBillingWorkspace, readWorkspaceEntitlement, readWorkspaceSubscriptionState } from './workspace'
import { workspaceCheckoutRehearsalEnabled, WorkspaceCheckoutConflict } from './workspace-checkout'

export const changeSelectionSchema = z.object({
  offer: z.enum(paidOffers), interval: z.enum(['month', 'year']), quantity: z.literal(1),
}).strict()
const subscriptionSchema = z.object({
  id: z.string(), customer: z.string(), livemode: z.literal(false),
  status: z.literal('active'), collection_method: z.literal('charge_automatically'),
  cancel_at_period_end: z.literal(false), cancel_at: z.null(),
  schedule: z.null(), pending_update: z.null(), latest_invoice: z.string().regex(/^in_\w+$/),
  items: z.object({ has_more: z.literal(false), data: z.array(z.object({
    id: z.string().regex(/^si_\w+$/), quantity: z.literal(1), price: priceSchema,
    current_period_start: z.number().int().positive(),
    current_period_end: z.number().int().positive(),
  })).min(1).max(2) }),
})
const invoiceIdentity = z.object({
  customer: z.string(), livemode: z.literal(false), currency: z.literal('usd'),
  parent: z.object({ subscription_details: z.object({ subscription: z.string() }) }),
})
const previewSchema = invoiceIdentity.extend({
  id: z.string().min(1), amount_due: z.number().int().nonnegative(),
  total: z.number().int(), subtotal: z.number().int(),
  starting_balance: z.literal(0),
  lines: z.object({ has_more: z.literal(false), data: z.array(z.object({
    amount: z.number().int(), quantity: z.literal(1),
    period: z.object({ start: z.number().int(), end: z.number().int() }),
    pricing: z.object({ price_details: z.object({ price: z.string() }) }),
    parent: z.object({ subscription_item_details: z.object({
      subscription: z.string(), proration: z.literal(true),
    }) }),
  })).min(1).max(4) }),
})
const conflict = (message: string): never => { throw new WorkspaceCheckoutConflict(message) }

/** Preview only. Stripe owns proration arithmetic; persist the exact timestamp,
 * parameters, quote and source revision needed by a later confirmation handler.
 * External calls never hold the workspace lock.
 */
export async function reviewWorkspaceChange(env: Env, orgId: number, raw: unknown,
  requestUrl: string, now = new Date()): Promise<BillingChangeReview> {
  if (!workspaceCheckoutRehearsalEnabled(env, requestUrl)) throw new Error('Plan changes disabled')
  const input = changeSelectionSchema.parse(raw)
  const db = env.AQUILLA_PG
  if (!db.transaction) throw new Error('Plan review requires transactions')
  const [workspace, stored, state] = await Promise.all([
    readBillingWorkspace(db, orgId, now), readWorkspaceEntitlement(db, orgId),
    readWorkspaceSubscriptionState(db, orgId),
  ])
  if (!workspace || !stored || !state || workspace.eligibility.reason !== 'already_subscribed'
    || state.payment_failed || state.cancel_at_period_end
    || Date.parse(state.paid_through) <= now.getTime()) {
    return conflict('An active paid workspace is required. Resolve billing before changing plans')
  }
  if (input.interval !== stored.billing_interval) return conflict('Billing-period changes require a separate review')
  if (input.offer === stored.offer) return conflict('This workspace already has that plan')
  if ((input.offer.startsWith('team') ? 'team' : 'personal') !== stored.scope) {
    return conflict('A plan change cannot change the workspace type')
  }
  const { catalog, prices, offers } = await readValidatedBillingCatalog(env)
  const attempt = await db.prepare(`SELECT account_id FROM workspace_checkout_attempts
    WHERE org_id = ? AND resolved_at IS NULL AND session_id IS NOT NULL`)
    .bind(orgId).first<{ account_id: string }>()
  if (attempt?.account_id !== catalog.accountId || catalog.version !== stored.price_version
    || catalog.entitlementVersion !== stored.entitlement_version) {
    return conflict('Existing pricing requires a separate review')
  }
  const sourceQuote = quoteOffer(catalog, prices, stored.offer, stored.billing_interval, stored.quantity)
  const targetQuote = quoteOffer(catalog, prices, input.offer, input.interval, input.quantity)
  const direction = weeklyAllowance(input.offer) > weeklyAllowance(stored.offer, stored.quantity)
    ? 'upgrade' as const : 'downgrade' as const
  if ((direction === 'upgrade') !== (targetQuote.totalAmount > sourceQuote.totalAmount)) {
    return conflict('Plan price and allowance direction do not agree')
  }
  const sub = subscriptionSchema.parse(await stripeForm(env, 'GET',
    `/subscriptions/${encodeURIComponent(stored.stripe_subscription_id)}`))
  const items = sub.items.data
  const ids = items.map(item => item.price.id).sort()
  const expected = sourceQuote.lineItems.map(line => line.price).sort()
  const seconds = Math.floor(now.getTime() / 1000)
  const first = items[0]!
  if (sub.id !== stored.stripe_subscription_id || sub.customer !== stored.stripe_customer_id
    || JSON.stringify(ids) !== JSON.stringify(expected)
    || JSON.stringify([...stored.price_ids].sort()) !== JSON.stringify(expected)
    || new Set(items.map(item => item.id)).size !== items.length
    || items.some(item => item.current_period_start !== first.current_period_start
      || item.current_period_end !== first.current_period_end)
    || first.current_period_start > seconds || first.current_period_end <= seconds
    || first.current_period_end * 1000 !== Date.parse(state.paid_through)) {
    return conflict('The Stripe subscription changed. Reconcile billing and review again')
  }
  const actual = quoteOffer(catalog, items.map(item => item.price), stored.offer,
    stored.billing_interval, stored.quantity)
  if (actual.totalAmount !== sourceQuote.totalAmount) return conflict('The current price changed')
  const invoiceRaw = await stripeForm(env, 'GET', `/invoices/${sub.latest_invoice}`)
  const invoice = invoiceIdentity.extend({ id: z.string(), status: z.literal('paid'),
    paid: z.literal(true), amount_remaining: z.literal(0),
  }).parse(invoiceRaw)
  if (invoice.id !== sub.latest_invoice || invoice.customer !== sub.customer
    || invoice.parent.subscription_details.subscription !== sub.id) {
    return conflict('The current subscription invoice is not verified')
  }
  // Retain unchanged components (Team platform) instead of charging them twice.
  const params: Record<string, string | number> = {}
  const remaining = [...items]
  let index = 0
  for (const line of targetQuote.lineItems) {
    const same = remaining.findIndex(item => item.price.id === line.price)
    const item = same >= 0 ? remaining.splice(same, 1)[0] : remaining.shift()
    if (item) params[`items[${index}][id]`] = item.id
    params[`items[${index}][price]`] = line.price
    params[`items[${index}][quantity]`] = line.quantity
    index++
  }
  for (const item of remaining) {
    params[`items[${index}][id]`] = item.id
    params[`items[${index}][deleted]`] = 'true'
    index++
  }
  let amountDueNow = 0
  let preview: z.infer<typeof previewSchema> | null = null
  if (direction === 'upgrade') {
    params.proration_date = seconds
    params.proration_behavior = 'always_invoice'
    params.payment_behavior = 'pending_if_incomplete'
    params.billing_cycle_anchor = 'unchanged'
    const previewParams: Record<string, string | number> = { customer: sub.customer, subscription: sub.id }
    for (const [key, value] of Object.entries(params)) {
      if (key === 'payment_behavior') continue
      const bracket = key.indexOf('[')
      const root = bracket < 0 ? key : key.slice(0, bracket)
      const rest = bracket < 0 ? '' : key.slice(bracket)
      previewParams[`subscription_details[${root}]${rest}`] = value
    }
    preview = previewSchema.parse(await stripeForm(env, 'POST', '/invoices/create_preview', previewParams))
    const targetIds = targetQuote.lineItems.map(line => line.price)
    const oldPrices = new Set(ids.filter(id => !targetIds.includes(id)))
    const newPrices = new Set(targetIds.filter(id => !ids.includes(id)))
    if (preview.customer !== sub.customer || preview.parent.subscription_details.subscription !== sub.id
      || preview.amount_due !== preview.total || preview.total !== preview.subtotal
      || preview.lines.data.reduce((sum, line) => sum + line.amount, 0) !== preview.total
      || !preview.lines.data.some(line => newPrices.has(line.pricing.price_details.price))
      || preview.lines.data.some(line => !(
        (line.amount <= 0 && oldPrices.has(line.pricing.price_details.price))
        || (line.amount >= 0 && newPrices.has(line.pricing.price_details.price)))
        || line.parent.subscription_item_details.subscription !== sub.id
        || line.period.start !== seconds || line.period.end !== first.current_period_end)) {
      return conflict('The preview contains additional charges or unsupported adjustments')
    }
    amountDueNow = preview.amount_due
  }
  const target = offers.offers.find(offer => offer.offer === input.offer && offer.interval === input.interval)!
  const period = weeklyUsagePeriod(stored.usage_anchor, now.toISOString())
  const review: BillingChangeReview = { id: crypto.randomUUID(),
    workspace: { orgId, name: workspace.name, scope: workspace.scope }, direction,
    currentOffer: stored.offer, target, amountDueNow,
    effectiveAt: new Date((direction === 'upgrade' ? seconds : first.current_period_end) * 1000).toISOString(),
    expiresAt: new Date(Math.min(now.getTime() + 15 * 60_000, first.current_period_end * 1000)).toISOString(),
    usagePeriodStart: period.start, usagePeriodEnd: period.end, changesEnabled: false }
  await db.transaction(async tx => {
    await tx.prepare('SELECT id FROM organizations WHERE id = ? FOR UPDATE').bind(orgId).first()
    const fresh = await readWorkspaceSubscriptionState(tx, orgId)
    const freshPlan = await readWorkspaceEntitlement(tx, orgId)
    const freshWorkspace = await readBillingWorkspace(tx, orgId, now)
    if (fresh?.revision !== state.revision || JSON.stringify(freshPlan) !== JSON.stringify(stored)
      || freshWorkspace?.eligibility.reason !== 'already_subscribed') {
      return conflict('Billing changed while reviewing. Review the plan again')
    }
    await tx.prepare(`INSERT INTO workspace_plan_change_reviews
      (id, org_id, account_id, direction, source_json, quote_json, request_params,
       invoice_json, review_json, expires_at)
      VALUES (?, ?, ?, ?, ?::text::jsonb, ?::text::jsonb, ?::text::jsonb,
        ?::text::jsonb, ?::text::jsonb, ?::timestamptz)`)
      .bind(review.id, orgId, catalog.accountId, direction,
        JSON.stringify({ entitlement: stored, revision: state.revision, subscription: sub }),
        JSON.stringify(targetQuote), JSON.stringify(params), JSON.stringify(preview),
        JSON.stringify(review), review.expiresAt).run()
  })
  return review
}
