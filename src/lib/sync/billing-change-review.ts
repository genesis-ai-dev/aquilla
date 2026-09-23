import { FRONTIER_BASE } from '../frontier/auth'
import { fetchWithTimeout } from '../frontier/orgs'
import { billingOfferLabels } from '../../../db/shared/billing-offers'
import type { BillingPlanSelection } from '../../../db/shared/billing-review'
import type { BillingChangeReview } from '../../../db/shared/billing-change-review'
export type { BillingChangeReview } from '../../../db/shared/billing-change-review'

export async function getBillingChangeReview(jwt: string, orgId: number,
  selection: BillingPlanSelection): Promise<BillingChangeReview> {
  const response = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/billing/change-rehearsal/review`,
    { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(selection) },
  )
  if (!response.ok) throw new Error('Plan change review is unavailable')
  const review = await response.json() as BillingChangeReview
  if (!review || review.workspace?.orgId !== orgId
    || review.target?.offer !== selection.offer || review.target.interval !== selection.interval
    || review.target.currency !== 'usd' || !Object.hasOwn(billingOfferLabels, review.currentOffer)
    || !['upgrade', 'downgrade'].includes(review.direction) || review.changesEnabled !== false
    || typeof review.id !== 'string' || !/^[a-f0-9-]{36}$/.test(review.id)
    || !Number.isSafeInteger(review.amountDueNow) || review.amountDueNow < 0
    || !Number.isSafeInteger(review.target.totalAmount) || review.target.totalAmount < 0
    || ['effectiveAt', 'expiresAt', 'usagePeriodStart', 'usagePeriodEnd'].some(
      key => !Number.isFinite(Date.parse(review[key as 'effectiveAt'])))
    || (review.direction === 'downgrade' && review.amountDueNow !== 0)) {
    throw new Error('Plan change review response mismatch')
  }
  return review
}
