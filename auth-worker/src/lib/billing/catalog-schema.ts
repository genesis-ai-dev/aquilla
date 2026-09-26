import { z } from 'zod'
import { paidOffers } from './catalog-view'

export const catalogSchema = z.object({
  checkoutLayout: z.enum(['single_item', 'team_addon']).optional(),
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
