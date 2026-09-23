import type { BillingOffers } from '../../../../db/shared/billing-offers'
import type { BillingWorkspace } from '../../../../db/shared/billing-workspace'
import type { BillingPlanReview, BillingPlanSelection } from '../../../../db/shared/billing-review'

/** Preview only: no cohort assignment, payment, entitlement, or usage mutation. */
export function reviewBillingPlan(
  workspace: BillingWorkspace, selection: BillingPlanSelection, offers: BillingOffers,
): BillingPlanReview {
  const base = { workspace: { orgId: workspace.orgId, name: workspace.name,
    scope: workspace.scope }, checkoutEnabled: false as const }
  if (workspace.eligibility.reason !== 'ready') {
    return { ...base, ready: false, reason: workspace.eligibility.reason }
  }
  if (!workspace.eligibility.offers.includes(selection.offer)) {
    return { ...base, ready: false, reason: 'wrong_scope' }
  }
  const offer = offers.offers.find(item => item.offer === selection.offer
    && item.interval === selection.interval && item.scope === workspace.scope)
  if (!offers.available || !offers.priceVersion || !offers.entitlementVersion || !offer) {
    throw new Error('Plan prices are unavailable')
  }
  return { ...base, ready: true, offer, priceVersion: offers.priceVersion,
    entitlementVersion: offers.entitlementVersion }
}
