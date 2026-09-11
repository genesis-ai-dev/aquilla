import { z } from 'zod'
import type { BillingOffers } from '../../../../db/shared/billing-offers'
import type { Env } from '../../types'
import { paidOffers, presentBillingOffers } from './catalog-view'
import { requireStripeSecret, stripeForm } from './stripe'

export const catalogSchema = z.object({
  version: z.string().min(1),
  entitlementVersion: z.literal('2026-09-weekly'),
  accountId: z.string().startsWith('acct_'),
  bindings: z.array(z.object({
    priceId: z.string().startsWith('price_'),
    productId: z.string().min(1),
    offer: z.enum(paidOffers),
    interval: z.enum(['month', 'year']),
    currency: z.literal('usd'),
    live: z.boolean(),
    // A higher self-service quantity still needs commercial approval.
    maxQuantity: z.literal(1),
  })).length(10),
})
export const priceSchema = z.object({
  id: z.string(), product: z.union([z.string(), z.object({ id: z.string() })]),
  active: z.boolean(), livemode: z.boolean(), type: z.string(),
  billing_scheme: z.string(), currency: z.string(),
  unit_amount: z.number().nullable(),
  recurring: z.object({
    interval: z.string(), interval_count: z.number(), usage_type: z.string(),
  }).nullable(),
  transform_quantity: z.unknown().optional(),
})
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
