/** New-offer contract. Existing Field subscriptions retain their legacy rules. */
export type Offer = 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team' | 'team_20x'
const credits: Record<Offer, number> = {
  free: 100, pro: 200, max_5x: 1000, max_20x: 4000, team: 1000, team_20x: 4000,
}
export function monthlyAllowance(offer: Offer, quantity = 1): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1
    || (quantity !== 1 && offer !== 'max_20x' && offer !== 'team_20x')) {
    throw new Error('Invalid capacity quantity')
  }
  const allowance = credits[offer] * quantity
  if (!Number.isSafeInteger(allowance)) throw new Error('Invalid allowance')
  return allowance
}

/** Clamp from the original UTC anchor every time; February must not cause drift. */
function anniversary(anchor: Date, offset: number): Date {
  const date = new Date(anchor)
  date.setUTCDate(1)
  date.setUTCMonth(anchor.getUTCMonth() + offset)
  const lastDay = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + 1, 0,
  )).getUTCDate()
  date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay))
  return date
}

/** End-exclusive credit period. Annual payment still uses monthly periods. */
export function monthlyUsagePeriod(anchorIso: string, nowIso: string) {
  const anchor = new Date(anchorIso)
  const now = new Date(nowIso)
  if (!Number.isFinite(anchor.getTime()) || !Number.isFinite(now.getTime())
    || now < anchor) throw new Error('Invalid usage period timestamp')
  let offset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + now.getUTCMonth() - anchor.getUTCMonth()
  if (anniversary(anchor, offset) > now) offset -= 1
  return {
    start: anniversary(anchor, offset).toISOString(),
    end: anniversary(anchor, offset + 1).toISOString(),
  }
}

export interface ApprovedPriceBinding {
  priceId: string
  productId: string
  // team_20x is the capacity line; checkout also requires team at quantity one.
  offer: Exclude<Offer, 'free'>
  interval: 'month' | 'year'
  currency: string
  live: boolean
  maxQuantity: number
}
export interface StripePriceInput {
  id: string
  product: string | { id: string }
  active: boolean
  livemode: boolean
  type: string
  billing_scheme: string
  currency: string
  unit_amount: number | null
  recurring: { interval: string; interval_count: number; usage_type: string } | null
  transform_quantity?: unknown
}

/** Explicit approved IDs grant entitlements; names, metadata and amounts do not. */
export function resolveApprovedPrice(
  bindings: readonly ApprovedPriceBinding[], price: StripePriceInput, quantity: number,
) {
  const matches = bindings.filter(binding => binding.priceId === price.id)
  if (matches.length !== 1) throw new Error('Price is not uniquely approved')
  const binding = matches[0]!
  const product = typeof price.product === 'string' ? price.product : price.product.id
  if (product !== binding.productId || !price.active
    || price.livemode !== binding.live || price.type !== 'recurring'
    || price.billing_scheme !== 'per_unit' || price.transform_quantity != null
    || price.currency !== binding.currency
    || price.recurring?.interval !== binding.interval
    || price.recurring.interval_count !== 1
    || price.recurring.usage_type !== 'licensed'
    || price.unit_amount === null || !Number.isSafeInteger(price.unit_amount)
    || price.unit_amount < 0) throw new Error('Stripe price does not match approved offer')
  if (!Number.isSafeInteger(binding.maxQuantity) || binding.maxQuantity < 1
    || (binding.offer !== 'max_20x' && binding.offer !== 'team_20x'
      && binding.maxQuantity !== 1)
    || quantity > binding.maxQuantity) throw new Error('Capacity quantity is not approved')
  const allowanceCredits = monthlyAllowance(binding.offer, quantity)
  const totalAmount = price.unit_amount * quantity
  if (!Number.isSafeInteger(totalAmount)) throw new Error('Invalid price total')
  return {
    priceId: price.id, offer: binding.offer, quantity, allowanceCredits,
    scope: binding.offer.startsWith('team') ? 'team' as const : 'personal' as const,
    currency: price.currency, interval: binding.interval,
    unitAmount: price.unit_amount, totalAmount,
    monthlyEquivalent: binding.interval === 'year' ? totalAmount / 12 : totalAmount,
  }
}


export interface PriceCatalog {
  version: string
  entitlementVersion: string
  bindings: readonly ApprovedPriceBinding[]
}

/** Compose totals from Stripe prices; never use provisioning amounts as fallback. */
export function quoteOffer(
  catalog: PriceCatalog,
  stripePrices: readonly StripePriceInput[],
  offer: Exclude<Offer, 'free'>,
  interval: 'month' | 'year',
  quantity = 1,
) {
  const components: Array<{ offer: Exclude<Offer, 'free'>; quantity: number }> =
    offer === 'team_20x'
      ? [{ offer: 'team', quantity: 1 }, { offer: 'team_20x', quantity }]
      : [{ offer, quantity }]
  const lines = components.map(component => {
    const matches = catalog.bindings.filter(binding =>
      binding.offer === component.offer && binding.interval === interval)
    if (matches.length !== 1) throw new Error('Offer is not uniquely configured')
    const matchesInStripe = stripePrices.filter(price => price.id === matches[0]!.priceId)
    if (matchesInStripe.length !== 1) throw new Error('Stripe pricing unavailable')
    return resolveApprovedPrice(catalog.bindings, matchesInStripe[0]!, component.quantity)
  })
  const currency = lines[0]!.currency
  if (lines.some(line => line.currency !== currency)) throw new Error('Mixed currencies')
  const totalAmount = lines.reduce((total, line) => total + line.totalAmount, 0)
  if (!Number.isSafeInteger(totalAmount)) throw new Error('Invalid total')
  return {
    offer, quantity, interval, currency, totalAmount,
    monthlyEquivalent: interval === 'year' ? totalAmount / 12 : totalAmount,
    allowanceCredits: monthlyAllowance(offer, quantity),
    plan: offer.startsWith('team') ? 'team' : offer.startsWith('max') ? 'max' : 'pro',
    scope: offer.startsWith('team') ? 'team' : 'personal',
    capacity: offer.endsWith('20x') ? '20x_pro' : offer === 'max_5x' || offer === 'team' ? '5x_pro' : '2x_free',
    priceVersion: catalog.version,
    entitlementVersion: catalog.entitlementVersion,
    lineItems: lines.map(line => ({ price: line.priceId, quantity: line.quantity })),
  }
}

/** Event-time properties; do not use mutable person properties for paid cohorts. */
export function pricingEventProperties(
  quote: ReturnType<typeof quoteOffer>,
  cohort: { experiment: string | null; variant: string; acquisitionPriceVersion: string },
) {
  return {
    billing_plan: quote.plan,
    billing_offer: quote.offer,
    billing_scope: quote.scope,
    billing_capacity: quote.capacity,
    billing_quantity: quote.quantity,
    billing_interval: quote.interval,
    billing_currency: quote.currency,
    billing_price_version: quote.priceVersion,
    billing_entitlement_version: quote.entitlementVersion,
    billing_experiment: cohort.experiment,
    billing_variant: cohort.variant,
    billing_acquisition_price_version: cohort.acquisitionPriceVersion,
    billing_price_ids: quote.lineItems.map(line => line.price),
    billing_allowance_credits: quote.allowanceCredits,
  }
}
