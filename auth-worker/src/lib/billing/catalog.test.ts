import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../../../config/pricing/stripe-sandbox.json'
import { readBillingOffers } from './catalog'
import type { Env } from '../../types'
import { stripeCatalogResponse } from '../../__tests__/helpers/stripe-catalog'
const env = {
  STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_CATALOG: JSON.stringify(manifest),
} as Env
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
  it('composes ten validated offers without exposing internal ledger or price IDs', async () => {
    const fetch = mockStripe()
    const catalog = await readBillingOffers(env)
    expect(catalog.offers).toHaveLength(10)
    expect(catalog).toMatchObject({ available: true, usageInterval: 'week', checkoutEnabled: false })
    expect(catalog.offers.find(o => o.offer === 'team_20x' && o.interval === 'year'))
      .toMatchObject({ totalAmount: 720000, monthlyEquivalent: 60000, capacityLabel: '20× Pro', scope: 'team' })
    expect(JSON.stringify(catalog)).not.toMatch(/credits|price_1|sk_test/i)
    expect(fetch).toHaveBeenCalledTimes(11)
  })
  it.each([
    { active: false }, { livemode: true }, { currency: 'cad' },
    { product: 'wrong_product' }, { unit_amount: null },
    { recurring: { interval: 'week', interval_count: 4, usage_type: 'licensed' } },
    { transform_quantity: { divide_by: 2 } },
  ])('rejects a mismatched Stripe component: %j', async patch => {
    mockStripe(patch)
    await expect(readBillingOffers(env)).rejects.toThrow()
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
