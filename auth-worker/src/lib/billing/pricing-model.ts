import {
  DEFAULT_ALLOWANCE_POLICY, rawUsdToAllowanceUnits, teamWeeklyRawUsd,
} from '../../../../db/shared/allowance-policy'

// AQU-2059: the policy moved to db/shared so the plan resolver (both workers)
// reads the same numbers. Re-exported so existing imports keep working.
export {
  DEFAULT_ALLOWANCE_POLICY, rawUsdToAllowanceUnits, resolveAllowancePolicy,
  teamWeeklyRawUsd, weeklyUsagePeriod, type AllowancePolicy,
} from '../../../../db/shared/allowance-policy'

/** New-offer contract. Existing Field subscriptions retain their legacy rules. */
export type Offer = 'free' | 'team'

export function weeklyAllowance(offer: Offer, quantity = 1, policy = DEFAULT_ALLOWANCE_POLICY): number {
  if (!Number.isSafeInteger(quantity) || quantity !== 1 || (offer !== 'free' && offer !== 'team')) {
    throw new Error('Invalid capacity quantity')
  }
  return rawUsdToAllowanceUnits(offer === 'free' ? policy.freeWeeklyRawUsd : teamWeeklyRawUsd(policy))
}

/** Plan changes replace the cap without forgiving this week's consumption. */
export function remainingWeeklyAllowance(offer: Offer, used: number, quantity = 1) {
  if (!Number.isFinite(used) || used < 0) throw new Error('Invalid weekly usage')
  return Math.max(0, weeklyAllowance(offer, quantity) - used)
}

export interface ApprovedPriceBinding {
  priceId: string
  productId: string
  // Legacy catalogs use a capacity add-on; native catalogs use a complete plan price.
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
  if (binding.maxQuantity !== 1 || quantity !== 1) throw new Error('Capacity quantity is not approved')
  const allowanceCredits = weeklyAllowance(binding.offer, quantity)
  const totalAmount = price.unit_amount * quantity
  if (!Number.isSafeInteger(totalAmount)) throw new Error('Invalid price total')
  return {
    usageInterval: 'week' as const, priceId: price.id, offer: binding.offer, quantity, allowanceCredits,
    scope: 'team' as const,
    currency: price.currency, interval: binding.interval,
    unitAmount: price.unit_amount, totalAmount,
    monthlyEquivalent: binding.interval === 'year' ? totalAmount / 12 : totalAmount,
  }
}


export interface PriceCatalog {
  /** Omitted on historical records, which use the Team base plus capacity line. */
  checkoutLayout?: 'single_item' | 'team_addon'
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
  if (catalog.checkoutLayout === 'single_item' && quantity !== 1) {
    throw new Error('Single-item launch plans require quantity one')
  }
  const components = [{ offer, quantity }]
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
    plan: offer, scope: 'team' as const, capacity: offer,
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
