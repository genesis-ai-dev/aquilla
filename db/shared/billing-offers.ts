/** Customer-facing catalog: monetary amounts come from Stripe, ledger units stay private. */
export interface BillingOffer {
  // AQU-2058: Team is the only self-serve paid offer.
  offer: 'team'
  label: string
  scope: 'personal' | 'team'
  capacityLabel: string
  interval: 'month' | 'year'
  currency: string
  totalAmount: number
  monthlyEquivalent: number
}

export interface BillingOffers {
  available: boolean
  priceVersion: string | null
  entitlementVersion: string | null
  usageInterval: 'week'
  // Comparing plans is available before purchase integration is released.
  checkoutEnabled: false
  offers: BillingOffer[]
}

export const billingOfferLabels: Record<BillingOffer['offer'], string> = {
  team: 'Team',
}
