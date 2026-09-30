import type { WorkspaceAccess } from './workspace-access'
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
    access?: WorkspaceAccess
    scope: WorkspaceScope
    billingInterval: 'month' | 'year'
    priceVersion: string
    entitlementVersion: string
    usagePeriodStart: string
    usagePeriodEnd: string
  } | null
  /** Whole percent of this week's allowance committed (settled plus reserved),
   *  capped at 100 for display. null when the workspace has no measured
   *  allowance (legacy, covered, unconfirmed) or the ledger is unavailable:
   *  never an invented zero. */
  usagePercent: number | null
  /** Exact reset instant of the current weekly period, when measured. */
  usageResetsAt?: string
  /** Explicit server capability; absent means unavailable. */
  portalEnabled?: boolean
  checkoutEnabled: false
}
