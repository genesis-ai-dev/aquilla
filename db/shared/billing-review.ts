import type { BillingOffer } from './billing-offers'
import type { BillingWorkspace } from './billing-workspace'

export interface BillingPlanSelection {
  offer: BillingOffer['offer']
  interval: BillingOffer['interval']
  quantity: 1
}
export type BillingPlanReview = {
  workspace: Pick<BillingWorkspace, 'orgId' | 'name' | 'scope'>
  checkoutEnabled: false
} & ({
  ready: true
  offer: BillingOffer
  priceVersion: string
  entitlementVersion: string
} | {
  ready: false
  reason: Exclude<BillingWorkspace['eligibility']['reason'], 'ready'> | 'wrong_scope'
})
