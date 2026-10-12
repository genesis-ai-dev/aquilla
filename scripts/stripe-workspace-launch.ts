import { pathToFileURL } from 'node:url'
import { baseline } from './stripe-pricing-baseline'
import { catalogSchema, priceSchema } from '../auth-worker/src/lib/billing/catalog-schema'
import type { ApprovedPriceBinding } from '../auth-worker/src/lib/billing/pricing-model'
import { billingOfferLabels } from '../db/shared/billing-offers'

/** Prepare catalog objects only. Never enables sales or creates a charge. */
export async function prepareWorkspaceLaunch(options: {
  secret: string; accountId: string; live: boolean; apply: boolean
}) {
  const { secret, accountId, live, apply } = options
  if (!secret.startsWith(live ? 'sk_live_' : 'sk_test_')) throw new Error('Stripe mode mismatch')
  if (!/^acct_[a-zA-Z0-9]+$/.test(accountId)) throw new Error('Expected Stripe account required')
  const version = '2026-09-native'
  async function request(path: string, params?: Record<string, string>, identity?: string) {
    if (params && !apply) throw new Error('Catalog incomplete. Review and rerun with --apply to create missing objects.')
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method: params ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${secret}`,
        ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `aquilla-${version}-${identity}` } : {}) },
      body: params ? new URLSearchParams(params) : undefined,
    })
    if (!params && response.status === 404) return null
    const result = await response.json() as Record<string, unknown>
    if (!response.ok) {
      const error = result.error as { param?: string; code?: string } | undefined
      throw new Error(`Stripe preparation failed (${response.status}, ${error?.param ?? error?.code ?? 'request'}); inspect Stripe request logs.`)
    }
    return result
  }
  const account = await request('/account')
  if (account?.id !== accountId) throw new Error('Stripe account mismatch')
  if (live && account.charges_enabled !== true) throw new Error('Live charges are not enabled on this account')
  const bindings: ApprovedPriceBinding[] = []
  for (const component of baseline.components) {
    const productId = `aquilla_native_${component.key}_2026_09`
    const product = await request(`/products/${productId}`) ?? await request('/products', {
      id: productId, name: `Aquilla ${billingOfferLabels[component.key]}`,
      'metadata[aquilla_entitlement_version]': baseline.entitlementVersion,
    }, `product-${component.key}`)
    if (product?.id !== productId || product.active !== true || product.livemode !== live) {
      throw new Error('Native product mismatch')
    }
    for (const interval of ['month', 'year'] as const) {
      const amountField = interval === 'month' ? 'monthlyCents' : 'annualCents'
      // Bundle the Team platform charge once into its native 20× price.
      const amount = component[amountField] + (component.key === 'team_20x'
        ? baseline.components.find(c => c.key === 'team')![amountField] : 0)
      const lookup = `aquilla_native_2026_09_${component.key}_${interval}`
      const found = await request(`/prices?lookup_keys[]=${lookup}&limit=2`)
      const matches = (found?.data ?? []) as Record<string, unknown>[]
      if (matches.length > 1) throw new Error('Ambiguous native price')
      const raw = matches[0] ?? await request('/prices', {
        product: productId, currency: 'usd', unit_amount: String(amount),
        'recurring[interval]': interval, lookup_key: lookup,
      }, `price-${component.key}-${interval}`)
      const price = priceSchema.parse(raw)
      if (price.product !== productId || price.livemode !== live || !price.active
        || price.currency !== 'usd' || price.unit_amount !== amount
        || price.type !== 'recurring' || price.billing_scheme !== 'per_unit'
        || price.transform_quantity != null || price.recurring?.interval !== interval
        || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed') {
        throw new Error('Native price mismatch; existing prices remain unchanged')
      }
      bindings.push({ priceId: price.id, productId, offer: component.key,
        interval, currency: 'usd', live, maxQuantity: 1 })
    }
  }
  const catalog = catalogSchema.parse({ version, entitlementVersion: baseline.entitlementVersion,
    accountId, checkoutLayout: 'single_item', bindings })
  const configs = await request('/billing_portal/configurations?limit=100')
  if (configs?.has_more) throw new Error('Portal catalog needs operator review: more than 100 configurations')
  const configurations: Record<string, string> = {}
  for (const scope of ['personal', 'team'] as const) {
    const marker = `${version}-${scope}`
    const existing = ((configs?.data ?? []) as Record<string, unknown>[]).filter(config =>
      (config.metadata as Record<string, unknown> | undefined)?.aquilla_native === marker)
    if (existing.length > 1) throw new Error('Ambiguous portal configuration')
    const params: Record<string, string> = {
      'metadata[aquilla_native]': marker,
      'features[invoice_history][enabled]': 'true',
      'features[payment_method_update][enabled]': 'true',
      'features[subscription_cancel][enabled]': 'true',
      'features[subscription_cancel][mode]': 'at_period_end',
      'features[subscription_cancel][proration_behavior]': 'none',
      'features[subscription_update][enabled]': 'true',
      'features[subscription_update][default_allowed_updates][0]': 'price',
      'features[subscription_update][proration_behavior]': 'always_invoice',
      'features[subscription_update][billing_cycle_anchor]': 'unchanged',
    }
    const products = [...new Set(bindings.filter(b =>
      (b.offer.startsWith('team') ? 'team' : 'personal') === scope).map(b => b.productId))]
    products.forEach((product, i) => {
      const prefix = `features[subscription_update][products][${i}]`
      params[`${prefix}[product]`] = product
      bindings.filter(b => b.productId === product).forEach((binding, j) => {
        params[`${prefix}[prices][${j}]`] = binding.priceId
      })
      params[`${prefix}[adjustable_quantity][enabled]`] = 'false'
    })
    const created = existing[0] ?? await request('/billing_portal/configurations', params, `portal-${scope}`)
    if (typeof created?.id !== 'string') throw new Error('Portal identity missing')
    const portal = await request(`/billing_portal/configurations/${created.id}?expand%5B%5D=features.subscription_update.products`)
    if (typeof portal?.id !== 'string' || portal.livemode !== live || portal.active !== true) {
      throw new Error('Portal configuration mismatch')
    }
    const features = portal.features as Record<string, Record<string, unknown>> | undefined
    const update = features?.subscription_update
    const cancel = features?.subscription_cancel
    const actualProducts = update?.products as Array<{ product: string; prices: string[]; adjustable_quantity: { enabled: boolean } }> | undefined
    const expectedPrices = bindings.filter(b => products.includes(b.productId))
      .map(b => `${b.productId}:${b.priceId}`).sort()
    const actualPrices = actualProducts?.flatMap(p => p.prices.map(price => `${p.product}:${price}`)).sort()
    if (features?.invoice_history?.enabled !== true || features?.payment_method_update?.enabled !== true
      || cancel?.enabled !== true || cancel.mode !== 'at_period_end' || cancel.proration_behavior !== 'none'
      || update?.enabled !== true || update.proration_behavior !== 'always_invoice'
      || update.billing_cycle_anchor !== 'unchanged'
      || JSON.stringify(update.default_allowed_updates) !== JSON.stringify(['price'])
      || JSON.stringify((update.schedule_at_period_end as { conditions?: unknown })?.conditions) !== '[]'
      || actualProducts?.some(p => p.adjustable_quantity.enabled)
      || JSON.stringify(actualPrices) !== JSON.stringify(expectedPrices)) {
      throw new Error('Portal policy mismatch; existing configuration remains unchanged')
    }
    configurations[scope] = portal.id
  }
  return { catalog, configurations }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2)
  if (flags.some(flag => !['--live', '--apply'].includes(flag))) throw new Error('Unknown launch preparation flag')
  const result = await prepareWorkspaceLaunch({ secret: process.env.STRIPE_SECRET_KEY ?? '',
    accountId: process.env.STRIPE_ACCOUNT_ID ?? '', live: flags.includes('--live'), apply: flags.includes('--apply') })
  console.log(JSON.stringify(result, null, 2))
}
