import { FRONTIER_BASE } from '../frontier/auth'
import { fetchWithTimeout } from '../frontier/orgs'
import type { BillingPlanReview, BillingPlanSelection } from '../../../db/shared/billing-review'
export type { BillingPlanReview, BillingPlanSelection } from '../../../db/shared/billing-review'

export async function getBillingPlanReview(
  jwt: string, orgId: number, selection: BillingPlanSelection,
): Promise<BillingPlanReview> {
  const response = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/billing/review`,
    { method: 'POST', headers: { Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json' }, body: JSON.stringify(selection) },
  )
  if (!response.ok) throw new Error('Plan review is unavailable. Please try again.')
  const review = await response.json() as BillingPlanReview
  if (review.workspace.orgId !== orgId || (review.ready
    && (review.offer.offer !== selection.offer || review.offer.interval !== selection.interval))) {
    throw new Error('Plan review response mismatch')
  }
  return review
}
