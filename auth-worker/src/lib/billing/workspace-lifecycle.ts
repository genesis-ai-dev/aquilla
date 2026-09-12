import { z } from 'zod'
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
  cancel_at_period_end: z.boolean(), latest_invoice: z.string().regex(/^in_[\w]+$/),
  items: paidPeriodItems,
})
const invoiceSchema = z.object({
  id: z.string(), customer: z.string(), livemode: z.literal(false),
  status: z.enum(['paid', 'open', 'uncollectible', 'void', 'draft']),
  paid: z.boolean(), attempt_count: z.number().int().nonnegative(),
  amount_due: z.number().int().nonnegative(), amount_paid: z.number().int().nonnegative(),
  amount_remaining: z.number().int().nonnegative(), currency: z.literal('usd'),
  parent: z.object({ subscription_details: z.object({ subscription: z.string() }) }),
  lines: z.object({ has_more: z.literal(false), data: z.array(z.object({
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
  if (sub.id !== id || sub.customer !== stored.stripe_customer_id
    || JSON.stringify(sub.items.data.map(item => item.price.id).sort())
      !== JSON.stringify([...stored.price_ids].sort())) {
    // Plan mutations require reviewed proration/payment, not metadata or a name.
    throw new Error('Subscription change is not approved')
  }
  const invoice = invoiceSchema.parse(await stripeForm(env, 'GET', `/invoices/${sub.latest_invoice}`))
  if (invoice.id !== sub.latest_invoice || invoice.customer !== sub.customer
    || invoice.parent.subscription_details.subscription !== id) {
    throw new Error('Subscription invoice identity mismatch')
  }
  const paid = invoice.status === 'paid' && invoice.paid && invoice.amount_remaining === 0
    && invoice.amount_paid >= invoice.amount_due
  let paidThrough = before.paid_through
  if (paid) {
    const first = sub.items.data[0]!
    const expectedEnd = sub.status === 'canceled'
      ? Date.parse(before.paid_through) / 1000 : first.current_period_end
    if (JSON.stringify(invoice.lines.data.map(line => line.pricing.price_details.price).sort())
        !== JSON.stringify([...stored.price_ids].sort())
      || invoice.lines.data.some(line => line.period.end !== expectedEnd
        || line.period.start >= line.period.end
        || (sub.status !== 'canceled' && line.period.start !== first.current_period_start))) {
      throw new Error('Invoice does not pay for the current subscription period')
    }
    if (sub.status === 'active') {
      const end = subscriptionPaidThrough(sub.items, now)
      if (Date.parse(end) > Date.parse(paidThrough)) paidThrough = end
    }
  }
  const failed = (before.payment_failed && !paid) || ['past_due', 'unpaid'].includes(sub.status)
    || (!paid && invoice.attempt_count > 0)
  // Cancellation retains the last proven paid-through date, even if Stripe's
  // canceled snapshot shortens the period. No renewal resets the weekly anchor.
  return applyBillingEvent(env.AQUILLA_PG, owner.org_id, event.id, event.type, object, async tx => {
    const current = await readWorkspaceSubscriptionState(tx, owner.org_id)
    if (current?.revision !== before.revision) throw new Error('Subscription state changed; retry')
    await tx.prepare(`UPDATE workspace_subscription_state SET revision = revision + 1,
      payment_failed = ?, paid_through = ?::timestamptz,
      cancel_at_period_end = ?, updated_at = now() WHERE org_id = ?`)
      .bind(failed, paidThrough, sub.cancel_at_period_end || sub.status === 'canceled', owner.org_id).run()
  })
}
