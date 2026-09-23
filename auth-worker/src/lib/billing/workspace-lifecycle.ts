import { z } from 'zod'
import { readValidatedBillingCatalog } from './catalog'
import { quoteOffer } from './pricing-model'
import type { Env } from '../../types'
import { applyBillingEvent } from './apply'
import { stripeForm } from './stripe'
import { readWorkspaceEntitlement, readWorkspaceSubscriptionState } from './workspace'

export const workspaceLifecycleEvents = [
  'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
]
const timestamp = z.number().int().positive().max(8_640_000_000_000)
export const paidPeriodItems = z.object({
  has_more: z.literal(false), data: z.array(z.object({
    quantity: z.literal(1), price: z.object({ id: z.string() }),
    current_period_start: timestamp, current_period_end: timestamp,
  })).min(1).max(2),
})
export function subscriptionPaidThrough(items: z.infer<typeof paidPeriodItems>, now: Date) {
  const first = items.data[0]!
  if (first.current_period_start * 1000 > now.getTime()
    || first.current_period_end <= first.current_period_start
    || items.data.some(item => item.current_period_start !== first.current_period_start
      || item.current_period_end !== first.current_period_end)) {
    throw new Error('Subscription periods do not match')
  }
  return new Date(first.current_period_end * 1000).toISOString()
}
const subscriptionSchema = z.object({
  id: z.string(), customer: z.string(), livemode: z.literal(false),
  status: z.enum(['active', 'past_due', 'unpaid', 'canceled']),
  cancel_at_period_end: z.boolean(), cancel_at: timestamp.nullable().optional(), latest_invoice: z.string().regex(/^in_[\w]+$/),
  items: paidPeriodItems,
})
const invoiceSchema = z.object({
  id: z.string(), customer: z.string(), livemode: z.literal(false),
  status: z.enum(['paid', 'open', 'uncollectible', 'void', 'draft']),
  paid: z.boolean().optional(), billing_reason: z.string().optional(), attempt_count: z.number().int().nonnegative(),
  amount_due: z.number().int().nonnegative(), amount_paid: z.number().int().nonnegative(),
  amount_remaining: z.number().int().nonnegative(), currency: z.literal('usd'),
  parent: z.object({ subscription_details: z.object({ subscription: z.string() }) }),
  lines: z.object({ has_more: z.literal(false), data: z.array(z.object({
    amount: z.number().int().optional(), quantity: z.number().int().optional(),
    parent: z.object({ subscription_item_details: z.object({
      subscription: z.string(), proration: z.boolean(),
    }).nullable().optional() }).optional(),
    period: z.object({ start: timestamp, end: timestamp }),
    pricing: z.object({ price_details: z.object({ price: z.string() }) }),
  })).min(1).max(2) }),
})

/** Read current Stripe state rather than replaying stale webhook snapshots.
 * Optimistic revision checking prevents concurrent reads from overwriting newer
 * facts. Conflicts roll back the receipt and let Stripe retry with fresh reads.
 */
export async function reconcileWorkspaceLifecycle(env: Env, event: {
  id: string; type: string; created: number; livemode: boolean; account?: string
}, object: Record<string, unknown>, now = new Date()) {
  if (!workspaceLifecycleEvents.includes(event.type) || event.livemode !== false
    || !Number.isSafeInteger(event.created) || event.created <= 0
    || event.created * 1000 > now.getTime()) throw new Error('Invalid lifecycle event')
  const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined
  const id = z.string().regex(/^sub_[\w]+$/).parse(event.type.startsWith('customer.subscription.')
    ? object.id : object.subscription ?? parent?.subscription_details?.subscription)
  const owner = await env.AQUILLA_PG.prepare(
    'SELECT org_id FROM workspace_plan_entitlements WHERE stripe_subscription_id = ?',
  ).bind(id).first<{ org_id: number }>()
  if (!owner) throw new Error('Workspace subscription not activated')
  const stored = await readWorkspaceEntitlement(env.AQUILLA_PG, owner.org_id)
  const before = await readWorkspaceSubscriptionState(env.AQUILLA_PG, owner.org_id)
  if (!stored || !before) throw new Error('Subscription period requires reconciliation')
  const attempt = await env.AQUILLA_PG.prepare(`SELECT account_id FROM workspace_checkout_attempts
    WHERE org_id = ? AND session_id IS NOT NULL AND resolved_at IS NULL`)
    .bind(owner.org_id).first<{ account_id: string }>()
  const account = await stripeForm(env, 'GET', '/account')
  if (!attempt || account.id !== attempt.account_id
    || (event.account !== undefined && event.account !== attempt.account_id)) {
    throw new Error('Workspace subscription account mismatch')
  }
  const sub = subscriptionSchema.parse(await stripeForm(env, 'GET', `/subscriptions/${id}`))
  if (sub.id !== id || sub.customer !== stored.stripe_customer_id) {
    throw new Error('Subscription identity mismatch')
  }
  const currentPriceIds = sub.items.data.map(item => item.price.id).sort()
  const changed = JSON.stringify(currentPriceIds) !== JSON.stringify([...stored.price_ids].sort())
  const invoice = invoiceSchema.parse(await stripeForm(env, 'GET', `/invoices/${sub.latest_invoice}`))
  if (invoice.id !== sub.latest_invoice || invoice.customer !== sub.customer
    || invoice.parent.subscription_details.subscription !== id) {
    throw new Error('Subscription invoice identity mismatch')
  }
  // Modern Stripe invoices omit `paid`; status and settled amounts are authoritative.
  const paid = invoice.status === 'paid' && invoice.paid !== false && invoice.amount_remaining === 0
    && invoice.amount_paid >= invoice.amount_due
  let target: ReturnType<typeof quoteOffer> | null = null
  const prorated = invoice.billing_reason === 'subscription_update'
  if (changed || prorated) {
    const { catalog, prices } = await readValidatedBillingCatalog(env)
    if (catalog.checkoutLayout !== 'single_item' || catalog.accountId !== attempt.account_id
      || catalog.version !== stored.price_version
      || catalog.entitlementVersion !== stored.entitlement_version || sub.items.data.length !== 1) {
      throw new Error('Subscription change is not approved')
    }
    const binding = catalog.bindings.find(b => b.priceId === currentPriceIds[0])
    if (!binding || (binding.offer.startsWith('team') ? 'team' : 'personal') !== stored.scope) {
      throw new Error('Subscription change crosses workspace scope')
    }
    target = quoteOffer(catalog, prices, binding.offer, binding.interval)
    if (paid && prorated) {
      const item = sub.items.data[0]!
      const allowed = new Set(catalog.bindings.filter(b =>
        (b.offer.startsWith('team') ? 'team' : 'personal') === stored.scope).map(b => b.priceId))
      // Stripe owns the proration amount. Verify that this settled invoice pays
      // for the current item and that remaining lines only credit approved plans.
      const charges = invoice.lines.data.filter(line => line.pricing.price_details.price === item.price.id
        && line.amount !== undefined && line.amount >= 0)
      if (charges.length !== 1 || invoice.lines.data.some(line => {
        const details = line.parent?.subscription_item_details
        return !allowed.has(line.pricing.price_details.price) || line.quantity !== 1
          || details?.subscription !== id || details.proration !== true
          || line.amount === undefined
          || (line !== charges[0] && line.amount > 0)
          || (line === charges[0] && (line.period.end !== item.current_period_end
            || line.period.start < item.current_period_start))
          || line.period.start >= line.period.end || line.period.start * 1000 > now.getTime()
      })) throw new Error('Proration does not pay for the current subscription')
    }
  }
  let paidThrough = before.paid_through
  if (paid) {
    const first = sub.items.data[0]!
    const expectedEnd = sub.status === 'canceled'
      ? Date.parse(before.paid_through) / 1000 : first.current_period_end
    if (!prorated && (JSON.stringify(invoice.lines.data.map(line => line.pricing.price_details.price).sort())
        !== JSON.stringify(currentPriceIds)
      || invoice.lines.data.some(line => line.period.end !== expectedEnd
        || line.period.start >= line.period.end
        || (sub.status !== 'canceled' && line.period.start !== first.current_period_start)))) {
      throw new Error('Invoice does not pay for the current subscription period')
    }
    if (sub.status === 'active') {
      const end = subscriptionPaidThrough(sub.items, now)
      if (target || Date.parse(end) > Date.parse(paidThrough)) paidThrough = end
    }
  }
  const failed = (before.payment_failed && !paid) || ['past_due', 'unpaid'].includes(sub.status)
    || (!paid && invoice.attempt_count > 0)
  // Cancellation retains the last proven paid-through date, even if Stripe's
  // canceled snapshot shortens the period. No renewal resets the weekly anchor.
  return applyBillingEvent(env.AQUILLA_PG, owner.org_id, event.id, event.type, object, async tx => {
    const current = await readWorkspaceSubscriptionState(tx, owner.org_id)
    if (current?.revision !== before.revision) throw new Error('Subscription state changed; retry')
    if (changed && paid && target && sub.status === 'active') {
      await tx.prepare(`UPDATE workspace_plan_entitlements SET offer = ?, quantity = ?,
        price_ids = ?::text::jsonb, billing_interval = ? WHERE org_id = ?`)
        .bind(target.offer, target.quantity, JSON.stringify(target.lineItems.map(line => line.price)),
          target.interval, owner.org_id).run()
    }
    await tx.prepare(`UPDATE workspace_subscription_state SET revision = revision + 1,
      payment_failed = ?, paid_through = ?::timestamptz,
      cancel_at_period_end = ?, updated_at = now() WHERE org_id = ?`)
      .bind(failed, paidThrough, sub.cancel_at_period_end || sub.cancel_at != null || sub.status === 'canceled', owner.org_id).run()
  })
}
