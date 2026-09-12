import { catalogSchema, priceSchema } from './catalog-schema'
export { catalogSchema, priceSchema } from './catalog-schema'
import type { BillingOffers } from '../../../../db/shared/billing-offers'
import type { Env } from '../../types'
import { presentBillingOffers } from './catalog-view'
import { requireStripeSecret, stripeForm } from './stripe'

export function unavailableOffers(): BillingOffers {
  return {
    available: false, priceVersion: null, entitlementVersion: null,
    usageInterval: 'week', checkoutEnabled: false, offers: [],
  }
}

/** No fallback catalog, amounts, or automatic exposure/cohort assignment. */
export async function readValidatedBillingCatalog(env: Env) {
  const catalog = catalogSchema.parse(JSON.parse(env.STRIPE_PRICE_CATALOG ?? 'null'))
  const secret = requireStripeSecret(env)
  const live = /^(sk|rk)_live_/.test(secret)
  if (!/^(sk|rk)_(test|live)_/.test(secret)
    || catalog.bindings.some(binding => binding.live !== live)
    || new Set(catalog.bindings.map(binding => binding.priceId)).size !== 10) {
    throw new Error('Invalid catalog environment')
  }
  const account = await stripeForm(env, 'GET', '/account')
  if (account.id !== catalog.accountId) throw new Error('Catalog account mismatch')
  // Bound concurrency and fail the whole catalog if any component is unavailable.
  const prices = []
  for (let offset = 0; offset < catalog.bindings.length; offset += 3) {
    prices.push(...await Promise.all(catalog.bindings.slice(offset, offset + 3)
      .map(async binding => priceSchema.parse(await stripeForm(
        env, 'GET', `/prices/${encodeURIComponent(binding.priceId)}`,
      )))))
  }
  const offers = presentBillingOffers(catalog, prices)
  return { catalog, prices, offers }
}

export async function readBillingOffers(env: Env): Promise<BillingOffers> {
  return (await readValidatedBillingCatalog(env)).offers
}
