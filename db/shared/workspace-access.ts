import type { BillingOffer } from './billing-offers'

export interface WorkspaceAccess {
  offer: BillingOffer['offer'] | 'free'
  reason: 'paid' | 'payment_failed' | 'paid_period_ended'
  paidThrough: string
  cancelAtPeriodEnd: boolean
}

/** Failure changes the cap, never the usage anchor or recorded consumption. */
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
  const reason = input.paymentFailed ? 'payment_failed'
    : now.getTime() >= end ? 'paid_period_ended' : 'paid'
  return { offer: reason === 'paid' ? input.offer : 'free', reason,
    paidThrough: new Date(end).toISOString(), cancelAtPeriodEnd: input.cancelAtPeriodEnd }
}
