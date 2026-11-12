import { env as testEnv } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../../../config/pricing/stripe-sandbox.json'
import { readBillingOffers } from './catalog'
import type { Env } from '../../types'
import { stripeCatalogResponse } from '../../__tests__/helpers/stripe-catalog'
const env: Env = {
  ...testEnv, STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_CATALOG: JSON.stringify(manifest),
}
function mockStripe(patch: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    return Response.json({ ...stripeCatalogResponse(path), ...(path === '/v1/account' ? {} : patch) })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
afterEach(() => vi.unstubAllGlobals())
describe('authenticated price catalog adapter', () => {
  it('composes the two Team prices without exposing internal ledger or price IDs', async () => {
    const fetch = mockStripe()
    const catalog = await readBillingOffers(env)
    expect(catalog).toMatchObject({ available: true, usageInterval: 'week', checkoutEnabled: false })
    expect(catalog.offers).toEqual([
      expect.objectContaining({ offer: 'team', interval: 'month', totalAmount: 50000, monthlyEquivalent: 50000, scope: 'team' }),
      expect.objectContaining({ offer: 'team', interval: 'year', totalAmount: 500000, scope: 'team' }),
    ])
    expect(JSON.stringify(catalog)).not.toMatch(/credits|price_1|sk_test/i)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('rejects the retired ten-price catalog and a Team catalog missing an interval (AQU-2058)', async () => {
    const team = manifest.bindings[0]!
    const retired = { ...manifest, bindings: Array.from({ length: 10 }, (_, i) => ({ ...team, priceId: `price_old_${i}` })) }
    await expect(readBillingOffers({ ...env, STRIPE_PRICE_CATALOG: JSON.stringify(retired) })).rejects.toThrow()
    const twoMonthly = { ...manifest, bindings: [team, { ...team, priceId: 'price_other' }] }
    await expect(readBillingOffers({ ...env, STRIPE_PRICE_CATALOG: JSON.stringify(twoMonthly) })).rejects.toThrow()
    const pro = { ...manifest, bindings: manifest.bindings.map(b => ({ ...b, offer: 'pro' })) }
    await expect(readBillingOffers({ ...env, STRIPE_PRICE_CATALOG: JSON.stringify(pro) })).rejects.toThrow()
  })
  it.each([
    { active: false }, { livemode: true }, { currency: 'cad' },
    { product: 'wrong_product' }, { unit_amount: null },
    { recurring: { interval: 'week', interval_count: 4, usage_type: 'licensed' } },
    { transform_quantity: { divide_by: 2 } },
  ])('rejects a mismatched Stripe component: %j', async patch => {
    mockStripe(patch)
    await expect(readBillingOffers(env)).rejects.toThrow('Stripe price does not match approved offer')
  })
  it('never substitutes baseline amounts when Stripe fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await expect(readBillingOffers(env)).rejects.toThrow()
  })
  it('rejects another account before requesting prices', async () => {
    const fetch = vi.fn(async () => Response.json({ id: 'acct_wrong' }))
    vi.stubGlobal('fetch', fetch)
    await expect(readBillingOffers(env)).rejects.toThrow('account mismatch')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects live keys, duplicate bindings, and missing catalog before requests', async () => {
    const fetch = mockStripe()
    await expect(readBillingOffers({ ...env, STRIPE_SECRET_KEY: 'sk_live_fixture' })).rejects.toThrow()
    await expect(readBillingOffers({ ...env, STRIPE_PRICE_CATALOG: undefined })).rejects.toThrow()
    await expect(readBillingOffers({ ...env, STRIPE_PRICE_CATALOG: JSON.stringify({
      ...manifest, bindings: manifest.bindings.map(() => manifest.bindings[0]),
    }) })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
