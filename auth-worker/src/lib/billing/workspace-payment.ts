import { z } from 'zod'
import type { Env } from '../../types'
import { applyBillingEvent } from './apply'
import { catalogSchema, priceSchema } from './catalog'
import { paidOffers } from './catalog-view'
import { quoteOffer } from './pricing-model'
import { stripeForm } from './stripe'
import { recordInitialWorkspaceEntitlementInTransaction } from './workspace-entitlements'

import { paidPeriodItems, subscriptionPaidThrough } from './workspace-lifecycle'

const selectionSchema = z.object({
  offer: z.enum(paidOffers), interval: z.enum(['month', 'year']), quantity: z.literal(1),
})
const sessionSchema = z.object({
  id: z.string().regex(/^cs_test_[a-zA-Z0-9_]+$/), livemode: z.literal(false),
  mode: z.literal('subscription'), status: z.literal('complete'),
  payment_status: z.literal('paid'), client_reference_id: z.string(),
  customer: z.string().regex(/^cus_[a-zA-Z0-9_]+$/),
  subscription: z.string().regex(/^sub_[a-zA-Z0-9_]+$/),
  currency: z.literal('usd'), amount_subtotal: z.number().int(),
  amount_total: z.number().int(), metadata: z.record(z.string(), z.string()),
})
const subscriptionSchema = z.object({
  id: z.string(), customer: z.string(), livemode: z.literal(false),
  status: z.literal('active'), currency: z.literal('usd'),
  collection_method: z.literal('charge_automatically'),
  metadata: z.record(z.string(), z.string()),
  items: z.object({ has_more: z.literal(false), data: z.array(z.object({
    quantity: z.literal(1), price: priceSchema,
    current_period_start: z.number(), current_period_end: z.number(),
  })).min(1).max(2) }),
})
interface Attempt {
  id: string; org_id: number; account_id: string; session_id: string | null
  catalog_json: unknown; prices_json: unknown; quote_json: unknown
  request_params: Record<string, string | number>
}

/** Initial local sandbox activation only. No lifecycle policy is inferred here.
 * Stripe reads finish before the receipt/entitlement transaction starts.
 */
export async function reconcileWorkspacePayment(
  env: Env,
  event: { id: string; type: string; created: number; livemode: boolean; account?: string },
  object: Record<string, unknown>,
  now = new Date(),
) {
  if (event.livemode !== false || !Number.isSafeInteger(event.created)
    || event.created <= 0 || event.created * 1000 > now.getTime()
    || !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    throw new Error('Unsupported workspace payment event')
  }
  // An unpaid completion may precede a later async success. Its older event
  // timestamp must never become the activation anchor on a delayed retry.
  if (object.payment_status !== 'paid') throw new Error('Payment event is not paid')
  const sessionId = z.string().regex(/^cs_test_[a-zA-Z0-9_]+$/).parse(object.id)
  // Retrieve from the configured Stripe account; never grant from event metadata alone.
  const session = sessionSchema.parse(await stripeForm(env, 'GET',
    `/checkout/sessions/${encodeURIComponent(sessionId)}`))
  if (session.id !== sessionId) throw new Error('Checkout identity mismatch')
  const attemptId = z.string().uuid().parse(session.metadata.checkoutAttemptId)
  const attempt = await env.AQUILLA_PG.prepare(`SELECT id, org_id, account_id,
    session_id, catalog_json, prices_json, quote_json, request_params
    FROM workspace_checkout_attempts WHERE id = ?`).bind(attemptId).first<Attempt>()
  if (!attempt || (attempt.session_id !== null && attempt.session_id !== session.id)) {
    throw new Error('Checkout request not found or session changed')
  }
  const catalog = catalogSchema.parse(attempt.catalog_json)
  if (catalog.accountId !== attempt.account_id || catalog.bindings.some(b => b.live)
    || (event.account !== undefined && event.account !== attempt.account_id)) {
    throw new Error('Checkout account mismatch')
  }
  const account = await stripeForm(env, 'GET', '/account')
  if (account.id !== attempt.account_id) throw new Error('Stripe account changed')
  const selection = selectionSchema.parse(attempt.quote_json)
  const prices = z.array(priceSchema).parse(attempt.prices_json)
  const quote = quoteOffer(catalog, prices, selection.offer, selection.interval, selection.quantity)
  if (session.client_reference_id !== String(attempt.org_id)
    || session.amount_subtotal !== quote.totalAmount || session.amount_total !== quote.totalAmount
    || session.currency !== quote.currency) throw new Error('Checkout quote mismatch')
  const subscription = subscriptionSchema.parse(await stripeForm(env, 'GET',
    `/subscriptions/${encodeURIComponent(session.subscription)}`))
  if (subscription.id !== session.subscription || subscription.customer !== session.customer) {
    throw new Error('Checkout subscription mismatch')
  }
  const expectedMetadata = { orgId: String(attempt.org_id), kind: 'workspace_plan_rehearsal',
    checkoutAttemptId: attempt.id, offer: quote.offer, billingInterval: quote.interval,
    priceVersion: quote.priceVersion, entitlementVersion: quote.entitlementVersion }
  for (const [key, value] of Object.entries(expectedMetadata)) {
    if (session.metadata[key] !== value || subscription.metadata[key] !== value
      || attempt.request_params[`metadata[${key}]`] !== value) {
      throw new Error('Checkout metadata mismatch')
    }
  }
  const actualLines = subscription.items.data.map(item => [item.price.id, item.quantity]).sort()
  const expectedLines = quote.lineItems.map(item => [item.price, item.quantity]).sort()
  if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
    throw new Error('Subscription items differ from approved checkout')
  }
  const actualQuote = quoteOffer(catalog, subscription.items.data.map(item => item.price),
    selection.offer, selection.interval, selection.quantity)
  if (actualQuote.totalAmount !== quote.totalAmount) throw new Error('Subscription price changed')

  return applyBillingEvent(env.AQUILLA_PG, attempt.org_id, event.id, event.type, object, async tx => {
    // Recover a webhook arriving before the checkout response was saved. Never replace an ID.
    const saved = await tx.prepare(`UPDATE workspace_checkout_attempts SET session_id = ?
      WHERE id = ? AND resolved_at IS NULL
        AND (session_id IS NULL OR session_id = ?) RETURNING id`)
      .bind(session.id, attempt.id, session.id).first()
    if (!saved) throw new Error('Checkout session changed during reconciliation')
    const otherCohort = await tx.prepare(`SELECT price_version FROM billing_price_cohorts
      WHERE org_id = ? AND price_version <> ? LIMIT 1`).bind(attempt.org_id, quote.priceVersion).first()
    if (otherCohort) throw new Error('Pricing assignment changed during checkout')
    await recordInitialWorkspaceEntitlementInTransaction(tx, {
      orgId: attempt.org_id, catalog, prices, ...selection,
      subscriptionId: subscription.id, customerId: session.customer,
      activatedAt: new Date(event.created * 1000).toISOString(),
      paidThrough: subscriptionPaidThrough(paidPeriodItems.parse(subscription.items), now),
    }, now)
  })
}
