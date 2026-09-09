/** Customer-facing catalog: monetary amounts come from Stripe, ledger units stay private. */
export interface BillingOffer {
  offer: 'pro' | 'max_5x' | 'max_20x' | 'team' | 'team_20x'
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
