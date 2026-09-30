import type { BillingOffer } from './billing-offers'
import type { BillingWorkspace } from './billing-workspace'

/** A review never changes access or authorizes a different charge on retry. */
export interface BillingChangeReview {
  id: string
  workspace: Pick<BillingWorkspace, 'orgId' | 'name' | 'scope'>
  direction: 'upgrade' | 'downgrade'
  currentOffer: BillingOffer['offer']
  target: BillingOffer
  amountDueNow: number
  effectiveAt: string
  expiresAt: string
  usagePeriodStart: string
  usagePeriodEnd: string
  changesEnabled: false
}
