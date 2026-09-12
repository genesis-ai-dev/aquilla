import type { BillingOffer } from './billing-offers'

export type WorkspaceScope = 'personal' | 'team'
export type BillingEligibilityReason =
  | 'ready' | 'scope_unconfirmed' | 'existing_billing' | 'covered_access'
  | 'already_subscribed' | 'personal_collaboration_review'

/** Server-owned context. Eligibility is not permission to bypass the launch gate. */
export interface BillingWorkspace {
  orgId: number
  name: string | null
  scope: WorkspaceScope | null
  eligibility: {
    reason: BillingEligibilityReason
    offers: BillingOffer['offer'][]
  }
  entitlement: {
    offer: BillingOffer['offer']
    scope: WorkspaceScope
    billingInterval: 'month' | 'year'
    priceVersion: string
    entitlementVersion: string
    usagePeriodStart: string
    usagePeriodEnd: string
  } | null
  // The new metering consumer has not shipped. Never invent a percentage.
  usagePercent: null
  checkoutEnabled: false
}
