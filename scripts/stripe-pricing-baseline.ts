import process from 'node:process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { PriceCatalog, ApprovedPriceBinding } from '../auth-worker/src/lib/billing/pricing-model'

// These amounts are provisioning instructions, never a runtime display fallback.
export const baseline = JSON.parse(readFileSync(
  new URL('../config/pricing/baseline.json', import.meta.url), 'utf8',
)) as {
  version: string; entitlementVersion: string; currency: string
  selfServeMaxBlocks: number | null
  products: Array<{ key: string; name: string }>
  components: Array<{
    key: ApprovedPriceBinding['offer']; product: string
    monthlyCents: number; annualCents: number
  }>
}

export async function provisionBaseline(
  secret = process.env.STRIPE_SECRET_KEY?.trim(),
  productOverrides: Record<string, string> = {},
  priceOverrides: Record<string, string> = {},
): Promise<PriceCatalog> {
  if (!secret?.startsWith('sk_test_')) throw new Error('Only sandbox test keys are allowed')
  const max = baseline.selfServeMaxBlocks
  if (max !== null && (!Number.isSafeInteger(max) || max < 1)) {
    throw new Error('Invalid approved block limit')
  }
  async function request(path: string, body?: Record<string, string>) {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `${baseline.version}:${body.lookup_key ?? body.id}` } : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
    })
    if (response.status === 404 && !body) return null
    if (!response.ok) throw new Error(`Stripe request failed (${response.status})`)
    return await response.json() as Record<string, unknown>
  }
  const products = new Map<string, string>()
  for (const product of baseline.products) {
    const id = productOverrides[product.key] || `aquilla_${product.key}_2026_09`
    const existing = await request(`/products/${encodeURIComponent(id)}`)
    if (!existing) {
      if (productOverrides[product.key]) throw new Error('Supplied product is missing in this account')
      await request('/products', { id, name: product.name,
        'metadata[aquilla_entitlement_version]': baseline.entitlementVersion })
    } else if (existing.active === false) throw new Error('Supplied product is inactive')
    products.set(product.key, id)
  }
  const bindings: ApprovedPriceBinding[] = []
  for (const component of baseline.components) {
    for (const interval of ['month', 'year'] as const) {
      const amount = interval === 'month' ? component.monthlyCents : component.annualCents
      const lookup = `aquilla_${baseline.version}_${component.key}_${interval}`
      const override = priceOverrides[`${component.key}:${interval}`]
      const found = override
        ? await request(`/prices/${encodeURIComponent(override)}`)
        : await request(`/prices?lookup_keys[]=${encodeURIComponent(lookup)}&limit=2`)
      if (override && !found) throw new Error('Supplied price is missing in this account')
      const data = (found?.data ?? []) as Array<Record<string, unknown>>
      if (!override && data.length > 1) throw new Error('Ambiguous lookup key')
      const product = products.get(component.product)!
      const price = (override ? found : data[0]) ?? await request('/prices', {
        product, currency: baseline.currency, unit_amount: String(amount),
        'recurring[interval]': interval, 'recurring[interval_count]': '1',
        lookup_key: lookup,
        'metadata[aquilla_price_version]': baseline.version,
        'metadata[aquilla_component]': component.key,
      })
      const recurring = price?.recurring as Record<string, unknown> | undefined
      if (!price || typeof price.id !== 'string' || price.product !== product
        || price.unit_amount !== amount || price.currency !== baseline.currency
        || price.active !== true || price.livemode !== false
        || price.type !== 'recurring' || price.billing_scheme !== 'per_unit'
        || price.transform_quantity != null || recurring?.interval !== interval
        || recurring.interval_count !== 1 || recurring.usage_type !== 'licensed') {
        throw new Error(`Price mismatch for ${component.key}:${interval}; no existing price was changed`)
      }
      bindings.push({
        priceId: price.id, productId: product, offer: component.key,
        interval, currency: baseline.currency, live: false,
        maxQuantity: component.key.endsWith('20x') ? (max ?? 1) : 1,
      })
    }
  }
  return { version: baseline.version, entitlementVersion: baseline.entitlementVersion, bindings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const product = process.env.STRIPE_TEAM_PRODUCT_ID
  const monthly = process.env.STRIPE_TEAM_MONTHLY_PRICE_ID
  const annual = process.env.STRIPE_TEAM_ANNUAL_PRICE_ID
  const manifest = await provisionBaseline(undefined,
    product ? { team: product } : {},
    { ...(monthly ? { 'team:month': monthly } : {}),
      ...(annual ? { 'team:year': annual } : {}) },
  )
  console.log(JSON.stringify(manifest, null, 2))
}
