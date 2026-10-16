import { FRONTIER_BASE } from '../frontier/auth'
import { fetchWithTimeout } from '../frontier/orgs'
import type { BillingPlanReview } from '../../../db/shared/billing-review'

export class WorkspaceCheckoutConflict extends Error {}

export async function startWorkspaceBillingCheckout(
  jwt: string, review: Extract<BillingPlanReview, { ready: true }>,
): Promise<string> {
  if (!review.checkoutEnabled) throw new Error('Checkout is unavailable.')
  const response = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${review.workspace.orgId}/billing/workspace/checkout`,
    { method: 'POST', headers: { Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json' }, body: JSON.stringify({
      offer: review.offer.offer, interval: review.offer.interval, quantity: 1,
      confirmedPriceVersion: review.priceVersion,
      confirmedTotalAmount: review.offer.totalAmount,
      confirmedCurrency: review.offer.currency,
    }) },
  )
  if (response.status === 409) throw new WorkspaceCheckoutConflict('Your checkout changed. Review the plan again before continuing.')
  if (!response.ok) throw new Error('Checkout is unavailable. Please try again.')
  const result = await response.json() as { url?: unknown; sandbox?: unknown }
  const url = typeof result.url === 'string' ? new URL(result.url) : null
  if (typeof result.sandbox !== 'boolean' || !url || url.protocol !== 'https:'
    || url.hostname !== 'checkout.stripe.com' || url.username || url.password || url.port) {
    throw new Error('Checkout returned an invalid destination.')
  }
  return url.toString()
}

/** Only Stripe-confirmed expiration releases a pending checkout. */
export async function expireWorkspaceBillingCheckout(jwt: string, orgId: number) {
  const response = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/billing/workspace/checkout/expire`,
    { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!response.ok) throw new Error('The previous checkout could not be canceled. Please try again.')
  const result = await response.json() as { status?: unknown }
  if (result.status !== 'expired' && result.status !== 'none') {
    throw new Error('Payment confirmation is pending. Refresh workspace billing before trying another checkout.')
  }
}
