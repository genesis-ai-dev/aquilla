import { env } from 'cloudflare:test'
import app from '../index'
import { authHeader, jwtFor } from './helpers/db'
import { afterEach, expect, it, vi } from 'vitest'
import nativeManifest from '../../../config/pricing/stripe-sandbox-native.json'
import { catalogSchema, priceSchema } from '../lib/billing/catalog-schema'
import { quoteOffer } from '../lib/billing/pricing-model'
import { readBillingOffers } from '../lib/billing/catalog'
import { completedPayment, config } from './helpers/workspace-billing'
import { stripeCatalogResponse, testStripeCatalog } from './helpers/stripe-catalog'
import { readBillingWorkspace } from '../lib/billing/workspace'
import { startWorkspacePortalRehearsal } from '../lib/billing/workspace-portal'
const catalog = catalogSchema.parse(nativeManifest)
const prices = catalog.bindings.map(b => priceSchema.parse(stripeCatalogResponse(`/v1/prices/${b.priceId}`, catalog)))
afterEach(() => vi.unstubAllGlobals())

it.each(['month', 'year'] as const)('quotes bundled Team 20× once for %s', interval => {
  const quote = quoteOffer(catalog, prices, 'team_20x', interval)
  expect(quote.totalAmount).toBe(interval === 'month' ? 72000 : 720000)
  expect(quote.lineItems).toEqual([{ price: catalog.bindings.find(b =>
    b.offer === 'team_20x' && b.interval === interval)!.priceId, quantity: 1 }])
  expect(quote.allowanceCredits).toBe(1000)
  const oldPrices = testStripeCatalog.bindings.map(b => priceSchema.parse(stripeCatalogResponse(`/v1/prices/${b.priceId}`)))
  const old = quoteOffer(testStripeCatalog, oldPrices, 'team_20x', interval)
  expect(old.lineItems).toHaveLength(2)
  expect(old.totalAmount).toBe(quote.totalAmount)
})
it('rejects unapproved quantity and layout values', () => {
  expect(() => quoteOffer(catalog, prices, 'team_20x', 'month', 2)).toThrow('quantity one')
  expect(() => catalogSchema.parse({ ...nativeManifest, checkoutLayout: 'typo' })).toThrow()
})
it('feeds parsed native catalog into the real offer presenter', async () => {
  vi.stubGlobal('fetch', async (url: string) => Response.json(stripeCatalogResponse(new URL(url).pathname, catalog)))
  const result = await readBillingOffers(config(catalog))
  expect(result.offers).toHaveLength(10)
  expect(result.offers.find(o => o.offer === 'team_20x' && o.interval === 'year'))
    .toMatchObject({ totalAmount: 720000, monthlyEquivalent: 60000 })
  expect(result.priceVersion).toBe('2026-09-native')
  expect(result.checkoutEnabled).toBe(false)
})
it.each(['pro', 'max_5x', 'max_20x', 'team', 'team_20x'])(
  '%s checkout → signed activation → workspace → hosted session preserves single-item identity', async offer => {
    const paid = await completedPayment(offer, 'year', catalog)
    expect(paid.subscription.items.data).toHaveLength(1)
    expect((await paid.send()).status).toBe(200)
    const workspace = await readBillingWorkspace(env.AQUILLA_PG, 1)
    expect(workspace!.entitlement).toMatchObject({ offer, priceVersion: catalog.version })
    const before = await env.AQUILLA_PG.prepare('SELECT * FROM workspace_plan_entitlements').first()
    const upstream = globalThis.fetch
    const configuration = offer.startsWith('team') ? 'bpc_team' : 'bpc_personal'
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (path.startsWith('/v1/billing_portal/configurations/')) return Response.json({
        id: configuration, active: true, livemode: false, features: {
          invoice_history: { enabled: true }, payment_method_update: { enabled: true },
          subscription_update: { enabled: false }, subscription_cancel: { enabled: false },
        },
      })
      if (path === '/v1/billing_portal/sessions') {
        const params = new URLSearchParams(String(init?.body))
        expect(params.get('customer')).toBe(paid.session.customer)
        expect(params.get('configuration')).toBe(configuration)
        return Response.json({ customer: paid.session.customer, configuration,
          return_url: params.get('return_url'), livemode: false,
          url: 'https://billing.stripe.com/p/session/test' })
      }
      return upstream(url, init)
    })
    expect(await startWorkspacePortalRehearsal({ ...config(catalog),
      STRIPE_PORTAL_PERSONAL_CONFIGURATION: 'bpc_personal', STRIPE_PORTAL_TEAM_CONFIGURATION: 'bpc_team',
    }, 1, 'http://127.0.0.1')).toMatchObject({ sandbox: true })
    expect(await env.AQUILLA_PG.prepare('SELECT * FROM workspace_plan_entitlements').first()).toEqual(before)
    expect((await paid.send()).status).toBe(200)
    expect(await env.AQUILLA_PG.prepare('SELECT * FROM workspace_plan_entitlements').first()).toEqual(before)
  },
)

it.each(['personal', 'team'] as const)('opens the actual verified %s native portal configuration', async scope => {
  const { default: configurations } = await import('./fixtures/stripe-native-portal.json')
  const selected = structuredClone(configurations[scope])
  const paid = await completedPayment(scope === 'team' ? 'team' : 'pro', 'year', catalog)
  expect((await paid.send()).status).toBe(200)
  const upstream = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path.startsWith('/v1/billing_portal/configurations/')) return Response.json(selected)
    if (path === '/v1/billing_portal/sessions') {
      const params = new URLSearchParams(String(init?.body))
      return Response.json({ customer: paid.session.customer, configuration: selected.id,
        return_url: params.get('return_url'), livemode: false, url: 'https://billing.stripe.com/p/session/test' })
    }
    return upstream(url, init)
  })
  const settings = { ...config(catalog), STRIPE_PORTAL_PERSONAL_CONFIGURATION: selected.id,
    STRIPE_PORTAL_TEAM_CONFIGURATION: selected.id }
  const summary = await app.request('http://127.0.0.1/api/v2/orgs/1/billing/workspace', {
    headers: authHeader(await jwtFor('alice')),
  }, settings)
  expect(await summary.json()).toMatchObject({ orgId: 1, portalEnabled: true })
  const response = await app.request('http://127.0.0.1/api/v2/orgs/1/billing/portal-rehearsal', {
    method: 'POST', headers: authHeader(await jwtFor('alice')),
  }, settings)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ sandbox: true, url: 'https://billing.stripe.com/p/session/test' })
  selected.features.subscription_update.products[0]!.prices.push('price_unapproved')
  await expect(startWorkspacePortalRehearsal(settings, 1, 'http://127.0.0.1')).rejects.toThrow('approved catalog')
})
