import type { BillingOffer } from './billing-offers'

/** AQU-2058: Stripe Smart Retries run for this window; Team stays on meanwhile. */
export const PAYMENT_GRACE_DAYS = 7

export interface WorkspaceAccess {
  offer: BillingOffer['offer'] | 'free'
  reason: 'paid' | 'payment_grace' | 'payment_failed' | 'paid_period_ended'
  paidThrough: string
  /** End of the past-due grace window; set only while `reason` is 'payment_grace'. */
  graceEndsAt?: string
  cancelAtPeriodEnd: boolean
}

/** Failure changes the cap, never the usage anchor or recorded consumption.
 * A failed renewal keeps the paid offer until PAYMENT_GRACE_DAYS after the last
 * proven paid-through date, then falls back to Free.
 */
export function resolveWorkspaceAccess(input: {
  offer: BillingOffer['offer']
  paymentFailed: boolean
  paidThrough: string
  cancelAtPeriodEnd: boolean
}, now: Date): WorkspaceAccess {
  const end = Date.parse(input.paidThrough)
  if (!Number.isFinite(end) || !Number.isFinite(now.getTime())) {
    throw new Error('Invalid paid access period')
  }
  const graceEnd = end + PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000
  const reason = input.paymentFailed
    ? now.getTime() < graceEnd ? 'payment_grace' : 'payment_failed'
    : now.getTime() >= end ? 'paid_period_ended' : 'paid'
  const paid = reason === 'paid' || reason === 'payment_grace'
  return { offer: paid ? input.offer : 'free', reason,
    paidThrough: new Date(end).toISOString(),
    ...(reason === 'payment_grace' ? { graceEndsAt: new Date(graceEnd).toISOString() } : {}),
    cancelAtPeriodEnd: input.cancelAtPeriodEnd }
}
