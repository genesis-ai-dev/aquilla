import type { BillingOffer, BillingOffers } from '../../../../db/shared/billing-offers'
import { quoteOffer, type Offer, type PriceCatalog, type StripePriceInput } from './pricing-model'
export const paidOffers = ['pro', 'max_5x', 'max_20x', 'team', 'team_20x'] as const
const labels: Record<Exclude<Offer, 'free'>, string> = {
  pro: 'Pro', max_5x: 'Max 5×', max_20x: 'Max 20×',
  team: 'Team', team_20x: 'Team 20×',
}

export function presentBillingOffers(
  catalog: PriceCatalog, prices: readonly StripePriceInput[],
): BillingOffers {
  const offers: BillingOffer[] = []
  for (const offer of paidOffers) {
    for (const interval of ['month', 'year'] as const) {
      const quote = quoteOffer(catalog, prices, offer, interval)
      offers.push({
        offer, label: labels[offer], scope: offer.startsWith('team') ? 'team' : 'personal',
        capacityLabel: offer === 'pro' ? '2× Free' : offer.endsWith('20x') ? '20× Pro' : '5× Pro',
        interval, currency: quote.currency, totalAmount: quote.totalAmount,
        monthlyEquivalent: quote.monthlyEquivalent,
      })
    }
  }
  return {
    available: true, priceVersion: catalog.version,
    entitlementVersion: catalog.entitlementVersion, usageInterval: 'week',
    checkoutEnabled: false, offers,
  }
}
