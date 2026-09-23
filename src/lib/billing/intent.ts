import type { BillingPlanSelection } from '../../../db/shared/billing-review'

const offers: Record<string, BillingPlanSelection['offer']> = {
  pro: 'pro', max_5x: 'max_5x', 'max-5x': 'max_5x',
  max_20x: 'max_20x', 'max-20x': 'max_20x',
  team: 'team', team_20x: 'team_20x', 'team-20x': 'team_20x',
}
export type BillingIntent = { kind: 'none' | 'invalid' }
  | { kind: 'paid'; selection: BillingPlanSelection }

/** URL intent is a preference, never an entitlement or authoritative price. */
export function readBillingIntent(params: URLSearchParams): BillingIntent {
  if (!params.has('offer')) return { kind: 'none' }
  const allowed = ['offer', 'interval', 'quantity', 'audience']
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) {
    return { kind: 'invalid' }
  }
  const raw = params.get('offer') ?? ''
  const periods: Record<string, 'month' | 'year'> = { monthly: 'month', annual: 'year', month: 'month', year: 'year' }
  const rawInterval = params.get('interval') ?? ''
  const interval = Object.hasOwn(periods, rawInterval) ? periods[rawInterval] : undefined
  const quantity = params.get('quantity')
  const audience = params.get('audience')
  const team = raw.startsWith('team')
  if (!interval || quantity !== '1'
    || (audience !== null && audience !== (team ? 'team' : 'individual'))) {
    return { kind: 'invalid' }
  }
  if (raw === 'free') return { kind: 'none' }
  const offer = Object.hasOwn(offers, raw) ? offers[raw] : undefined
  return offer ? { kind: 'paid', selection: { offer, interval, quantity: 1 } } : { kind: 'invalid' }
}
export function billingSelectionPath(selection: BillingPlanSelection): string {
  return `/billing/select?${new URLSearchParams({ offer: selection.offer,
    interval: selection.interval, quantity: String(selection.quantity) })}`
}
export function onboardingForBillingNext(next: string): string {
  const url = new URL(next, 'https://aquilla.invalid')
  if (url.origin !== 'https://aquilla.invalid' || url.pathname !== '/billing/select') return '/onboarding'
  const intent = readBillingIntent(url.searchParams)
  return intent.kind === 'paid'
    ? billingSelectionPath(intent.selection).replace('/billing/select', '/onboarding') : '/onboarding'
}
