// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import launchFixture from './fixtures/stripe-workspace-launch.json'
import { prepareWorkspaceLaunch } from './stripe-workspace-launch'
import { baseline, provisionBaseline } from './stripe-pricing-baseline'
import { quoteOffer, pricingEventProperties, type StripePriceInput } from '../auth-worker/src/lib/billing/pricing-model'
afterEach(() => vi.unstubAllGlobals())

it('rejects live credentials without making requests', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(provisionBaseline('sk_live_fake')).rejects.toThrow('sandbox')
  expect(fetch).not.toHaveBeenCalled()
})

it('provisions reusable baseline prices and feeds the real quote/analytics consumers', async () => {
  const products = new Map<string, Record<string, unknown>>()
  const prices: Array<StripePriceInput & { lookup_key: string }> = []
  const writes: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const parsed = new URL(url)
    const path = parsed.pathname
    if (init?.method === 'POST') {
      writes.push(path)
      const body = new URLSearchParams(String(init.body))
      if (path === '/v1/products') {
        const product = { id: body.get('id')!, active: true }
        products.set(product.id, product)
        return Response.json(product)
      }
      const price = {
        id: `price_${prices.length}`, product: body.get('product')!,
        currency: body.get('currency')!, unit_amount: Number(body.get('unit_amount')),
        lookup_key: body.get('lookup_key')!, active: true, livemode: false,
        type: 'recurring', billing_scheme: 'per_unit',
        recurring: { interval: body.get('recurring[interval]')!, interval_count: 1, usage_type: 'licensed' },
      }
      prices.push(price)
      return Response.json(price)
    }
    if (path.includes('/products/')) {
      const product = products.get(path.split('/').at(-1)!)
      return product ? Response.json(product) : new Response('', { status: 404 })
    }
    return Response.json({ data: prices.filter(p => p.lookup_key === parsed.searchParams.get('lookup_keys[]')) })
  })
  const manifest = await provisionBaseline('sk_test_fake')
  expect(await provisionBaseline('sk_test_fake')).toEqual(manifest)
  expect(writes.filter(p => p.endsWith('/products'))).toHaveLength(3)
  expect(writes.filter(p => p.endsWith('/prices'))).toHaveLength(10)
  expect(baseline.selfServeMaxBlocks).toBeNull()
  for (const [offer, month, year] of [
    ['pro', 2000, 20000], ['max_5x', 6000, 60000],
    ['max_20x', 12000, 120000], ['team', 60000, 600000],
    ['team_20x', 72000, 720000],
  ] as const) {
    expect(quoteOffer(manifest, prices, offer, 'month').totalAmount).toBe(month)
    expect(quoteOffer(manifest, prices, offer, 'year').totalAmount).toBe(year)
  }
  // A future approved block limit enables quantity without multiplying platform fees.
  const expanded = { ...manifest, bindings: manifest.bindings.map(b => ({
    ...b, maxQuantity: b.offer.endsWith('20x') ? 3 : 1,
  })) }
  const team = quoteOffer(expanded, prices, 'team_20x', 'month', 3)
  expect(team).toMatchObject({ totalAmount: 96000, allowanceCredits: 3000 })
  expect(team.lineItems.map(i => i.quantity)).toEqual([1, 3])
  expect(quoteOffer(expanded, prices, 'max_20x', 'year', 2))
    .toMatchObject({ totalAmount: 240000, allowanceCredits: 2000 })
  expect(() => quoteOffer(manifest, prices, 'team_20x', 'month', 2)).toThrow()
  expect(() => quoteOffer(manifest, [], 'pro', 'month')).toThrow('unavailable')
  expect(pricingEventProperties(team, {
    experiment: null, variant: 'baseline', acquisitionPriceVersion: '2026-09-baseline',
  })).toMatchObject({ billing_plan: 'team', billing_quantity: 3,
    billing_price_version: '2026-09-baseline', billing_scope: 'team' })
  prices[0]!.unit_amount = 999
  await expect(provisionBaseline('sk_test_fake')).rejects.toThrow('Price mismatch')
  expect(writes).toHaveLength(13)
})

it('changes experiment prices without changing plan entitlements or acquisition cohorts', () => {
  const make = (version: string, id: string, amount: number) => {
    const catalog = {
      version, entitlementVersion: '2026-09',
      bindings: [{ priceId: id, productId: 'prod_max', offer: 'max_20x' as const,
        interval: 'month' as const, currency: 'usd', live: false, maxQuantity: 3 }],
    }
    const prices: StripePriceInput[] = [{
      id, product: 'prod_max', active: true, livemode: false,
      type: 'recurring', billing_scheme: 'per_unit', currency: 'usd', unit_amount: amount,
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    }]
    return quoteOffer(catalog, prices, 'max_20x', 'month')
  }
  const base = make('baseline-v1', 'price_baseline', 12000)
  const higher = make('higher-v1', 'price_higher', 16000)
  expect([base.allowanceCredits, higher.allowanceCredits]).toEqual([1000, 1000])
  expect([base.plan, higher.plan]).toEqual(['max', 'max'])
  expect([base.totalAmount, higher.totalAmount]).toEqual([12000, 16000])
  expect(pricingEventProperties(higher, {
    experiment: 'test-v1', variant: 'higher', acquisitionPriceVersion: 'baseline-v1',
  })).toMatchObject({ billing_price_version: 'higher-v1',
    billing_acquisition_price_version: 'baseline-v1', billing_plan: 'max' })
})

// Captured from the real Stripe sandbox preparation on 2026-10-04.
function nativeStripeFixture(live: boolean, present = true) {
  const fixture = structuredClone(launchFixture)
  for (const item of [...fixture.products, ...fixture.prices, ...fixture.configurations]) item.livemode = live
  const products = new Set(present ? fixture.products.map(p => p.id) : [])
  const prices = new Set(present ? fixture.prices.map(p => p.id) : [])
  const portals = new Set(present ? fixture.configurations.map(p => p.id) : [])
  const writes: string[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace('/v1', '')
    if (init?.method === 'POST') {
      writes.push(path)
      expect(init.headers).toHaveProperty('Idempotency-Key')
      const body = new URLSearchParams(String(init.body))
      if (path === '/products') {
        const product = fixture.products.find(p => p.id === body.get('id'))!
        products.add(product.id)
        return Response.json(product)
      }
      if (path === '/prices') {
        const price = fixture.prices.find(p => p.product === body.get('product')
          && p.recurring.interval === body.get('recurring[interval]')
          && p.unit_amount === Number(body.get('unit_amount')))!
        expect(price.lookup_key).toBe(body.get('lookup_key'))
        prices.add(price.id)
        return Response.json(price)
      }
      expect(path).toBe('/billing_portal/configurations')
      expect(body.get('features[subscription_update][default_allowed_updates][0]')).toBe('price')
      expect(body.get('features[subscription_update][proration_behavior]')).toBe('always_invoice')
      const portal = fixture.configurations.find(p => p.metadata.aquilla_native === body.get('metadata[aquilla_native]'))!
      portals.add(portal.id)
      return Response.json({ id: portal.id, active: true, livemode: live })
    }
    if (path === '/account') return Response.json({ id: fixture.accountId, charges_enabled: true })
    if (path.startsWith('/products/')) {
      const product = fixture.products.find(p => p.id === path.split('/').at(-1))!
      return products.has(product.id) ? Response.json(product) : new Response('', { status: 404 })
    }
    if (path === '/prices') return Response.json({ data: fixture.prices.filter(p =>
      prices.has(p.id) && p.lookup_key === parsed.searchParams.get('lookup_keys[]')) })
    if (path === '/billing_portal/configurations') return Response.json({ has_more: false,
      data: fixture.configurations.filter(p => portals.has(p.id)) })
    return Response.json(fixture.configurations.find(p => p.id === path.split('/').at(-1)))
  })
  vi.stubGlobal('fetch', fetch)
  return { fixture, writes, fetch }
}
it.each([false, true])('verifies native launch objects and sends their output through real pricing, live=%s', async live => {
  const { fixture, writes } = nativeStripeFixture(live)
  const result = await prepareWorkspaceLaunch({ secret: live ? 'sk_live_fixture' : 'sk_test_fixture',
    accountId: fixture.accountId, live, apply: false })
  expect(result.catalog.bindings).toHaveLength(10)
  expect(Object.keys(result.configurations)).toEqual(['personal', 'team'])
  expect(quoteOffer(result.catalog, fixture.prices, 'team_20x', 'month')).toMatchObject({
    totalAmount: 72000, allowanceCredits: 1000, lineItems: [expect.objectContaining({ quantity: 1 })] })
  expect(writes).toEqual([])
})
it('creates missing launch objects only with explicit apply and reuses them on a second run', async () => {
  const { fixture, writes } = nativeStripeFixture(false, false)
  const options = { secret: 'sk_test_fixture', accountId: fixture.accountId, live: false, apply: false }
  await expect(prepareWorkspaceLaunch(options)).rejects.toThrow('--apply')
  expect(writes).toHaveLength(0)
  const first = await prepareWorkspaceLaunch({ ...options, apply: true })
  expect(writes).toHaveLength(17)
  const second = await prepareWorkspaceLaunch({ ...options, apply: true })
  expect(second).toEqual(first)
  expect(writes).toHaveLength(17)
})
it('refuses wrong modes, accounts, prices, and portal policies without modifying existing objects', async () => {
  const { fixture, writes, fetch } = nativeStripeFixture(false)
  const options = { secret: 'sk_test_fixture', accountId: fixture.accountId, live: false, apply: true }
  await expect(prepareWorkspaceLaunch({ ...options, live: true })).rejects.toThrow('mode mismatch')
  expect(fetch).not.toHaveBeenCalled()
  await expect(prepareWorkspaceLaunch({ ...options, accountId: 'acct_other' })).rejects.toThrow('account mismatch')
  fixture.prices[0].unit_amount = 1
  await expect(prepareWorkspaceLaunch(options)).rejects.toThrow('price mismatch')
  fixture.prices[0].unit_amount = 2000
  fixture.configurations[0].features.subscription_cancel.mode = 'immediately'
  await expect(prepareWorkspaceLaunch(options)).rejects.toThrow('Portal policy mismatch')
  expect(writes).toEqual([])
})
