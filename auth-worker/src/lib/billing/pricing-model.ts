/** New-offer contract. Existing Field subscriptions retain their legacy rules. */
export type Offer = 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team' | 'team_20x'
const credits: Record<Offer, number> = {
  free: 25, pro: 50, max_5x: 250, max_20x: 1000, team: 250, team_20x: 1000,
}
export function weeklyAllowance(offer: Offer, quantity = 1): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1
    || (quantity !== 1 && offer !== 'max_20x' && offer !== 'team_20x')) {
    throw new Error('Invalid capacity quantity')
  }
  const allowance = credits[offer] * quantity
  if (!Number.isSafeInteger(allowance)) throw new Error('Invalid allowance')
  return allowance
}

/** Full seven-day periods, anchored to activation; billing never resets usage. */
export function weeklyUsagePeriod(anchorIso: string, nowIso: string) {
  const anchor = Date.parse(anchorIso)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(anchor) || !Number.isFinite(now) || now < anchor) {
    throw new Error('Invalid usage period timestamp')
  }
  const week = 7 * 24 * 60 * 60 * 1000
  const start = anchor + Math.floor((now - anchor) / week) * week
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + week).toISOString(),
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
  const allowanceCredits = weeklyAllowance(binding.offer, quantity)
  const totalAmount = price.unit_amount * quantity
  if (!Number.isSafeInteger(totalAmount)) throw new Error('Invalid price total')
  return {
    usageInterval: 'week' as const, priceId: price.id, offer: binding.offer, quantity, allowanceCredits,
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
    offer, quantity, interval, currency, totalAmount, usageInterval: 'week' as const,
    monthlyEquivalent: interval === 'year' ? totalAmount / 12 : totalAmount,
    allowanceCredits: weeklyAllowance(offer, quantity),
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
    billing_usage_interval: quote.usageInterval,
  }
}
