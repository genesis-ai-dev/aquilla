import { costMultiplier } from '../../../../db/shared/billing-cost'

/** New-offer contract. Existing Field subscriptions retain their legacy rules. */
export type Offer = 'free' | 'team'

/** AQU-2056: allowances are raw provider dollars per week. Team is a multiple
 * of Free so an admin change to Free moves Team with it (spec §4.3: Team at
 * 100% must stay within 25% of annual Team revenue).
 */
export interface AllowancePolicy { freeWeeklyRawUsd: number; teamMultipleOfFree: number }
export const DEFAULT_ALLOWANCE_POLICY: AllowancePolicy = { freeWeeklyRawUsd: 1, teamMultipleOfFree: 24 }

/** Missing fields take the default; a present but invalid value throws so a
 * bad admin save cannot silently become an unlimited or zero allowance.
 */
export function resolveAllowancePolicy(
  stored: { freeWeeklyRawUsd?: unknown; teamMultipleOfFree?: unknown } | undefined,
): AllowancePolicy {
  const free = stored?.freeWeeklyRawUsd ?? DEFAULT_ALLOWANCE_POLICY.freeWeeklyRawUsd
  const multiple = stored?.teamMultipleOfFree ?? DEFAULT_ALLOWANCE_POLICY.teamMultipleOfFree
  if (typeof free !== 'number' || !Number.isFinite(free) || free < 0 || free > 10_000) {
    throw new Error('Invalid Free weekly allowance')
  }
  if (typeof multiple !== 'number' || !Number.isFinite(multiple) || multiple < 1 || multiple > 1_000) {
    throw new Error('Invalid Team multiple of Free')
  }
  return { freeWeeklyRawUsd: free, teamMultipleOfFree: multiple }
}

export function teamWeeklyRawUsd(policy: AllowancePolicy): number {
  return policy.freeWeeklyRawUsd * policy.teamMultipleOfFree
}

/** The one raw-dollar → meter conversion. The meter counts units of one
 * marked-up cent (db/shared/billing-cost.ts); every rail shares one markup.
 * Units are internal: only admin screens may show them.
 */
export function rawUsdToAllowanceUnits(rawUsd: number): number {
  const units = Math.round(rawUsd * 100 * costMultiplier('llm'))
  if (!Number.isSafeInteger(units) || units < 0) throw new Error('Invalid allowance')
  return units
}

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
