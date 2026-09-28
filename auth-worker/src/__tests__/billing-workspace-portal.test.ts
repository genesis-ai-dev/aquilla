import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import { authHeader, jwtFor } from './helpers/db'
import { completedPayment, config, setup as setupFree } from './helpers/workspace-billing'
import type { Env } from '../types'

afterEach(() => vi.unstubAllGlobals())
function settings(): Env {
  return { ...config(), STRIPE_PORTAL_PERSONAL_CONFIGURATION: 'bpc_personal',
    STRIPE_PORTAL_TEAM_CONFIGURATION: 'bpc_team' }
}
async function openPortal(user = 'alice', options = settings(), org = '1',
  origin = 'http://127.0.0.1', body?: unknown) {
  return app.request(`${origin}/api/v2/orgs/${org}/billing/portal-rehearsal`, {
    method: 'POST', headers: authHeader(await jwtFor(user)),
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, options)
}
async function setup(offer = 'pro') {
  const paid = await completedPayment(offer)
  expect((await paid.send()).status).toBe(200)
  const upstream = globalThis.fetch
  const requests: URLSearchParams[] = []
  const configuration = { id: offer.startsWith('team') ? 'bpc_team' : 'bpc_personal',
    active: true, livemode: false, features: {
      invoice_history: { enabled: true }, payment_method_update: { enabled: true },
      subscription_update: { enabled: false }, subscription_cancel: { enabled: false },
    } }
  let transform = (session: Record<string, unknown>) => session
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path.startsWith('/v1/billing_portal/configurations/')) return Response.json(configuration)
    if (path === '/v1/billing_portal/sessions') {
      const params = new URLSearchParams(String(init?.body)); requests.push(params)
      return Response.json(transform({ id: 'bps_fixture', livemode: false,
        customer: params.get('customer'), configuration: params.get('configuration'),
        return_url: params.get('return_url'), url: 'https://billing.stripe.com/p/session/test' }))
    }
    return upstream(url, init)
  })
  vi.stubGlobal('fetch', fetch)
  return { paid, configuration, requests, fetch,
    transform: (fn: typeof transform) => { transform = fn } }
}
it.each(['pro', 'team_20x'])('opens the server-owned portal after signed %s activation', async offer => {
  const f = await setup(offer)
  const before = await env.AQUILLA_PG.prepare('SELECT * FROM workspace_plan_entitlements').first()
  const response = await openPortal('alice', settings(), '1', 'http://127.0.0.1', {
    customer: 'cus_someone_else', configuration: 'bpc_other', return_url: 'https://evil.test',
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ url: 'https://billing.stripe.com/p/session/test', sandbox: true })
  expect(Object.fromEntries(f.requests[0]!)).toEqual({ customer: 'cus_rehearsal',
    configuration: offer === 'pro' ? 'bpc_personal' : 'bpc_team',
    return_url: 'http://127.0.0.1:5173/orgs/1/settings/billing' })
  expect(await env.AQUILLA_PG.prepare('SELECT * FROM workspace_plan_entitlements').first()).toEqual(before)
})
it('denies non-maintainers before contacting Stripe', async () => {
  const f = await setup()
  expect((await openPortal('bob')).status).toBe(403)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('denies a free workspace', async () => {
  await setupFree()
  expect((await openPortal()).status).toBe(409)
})
it.each(['0', '1junk', '9007199254740992'])('rejects invalid workspace %s', async org => {
  const f = await setup()
  expect((await openPortal('alice', settings(), org)).status).toBe(400)
  expect(f.fetch).not.toHaveBeenCalled()
})
it.each([
  { WRANGLER_LOCAL: undefined }, { BILLING_WORKSPACE_CHECKOUT_REHEARSAL: 'false' },
  { STRIPE_SECRET_KEY: 'sk_live_fixture' },
])('keeps portal disabled outside the rehearsal gate: %j', async override => {
  const f = await setup()
  expect((await openPortal('alice', { ...settings(), ...override })).status).toBe(503)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('rejects deployed request origins', async () => {
  const f = await setup()
  expect((await openPortal('alice', settings(), '1', 'https://api.aquilla.app')).status).toBe(503)
  expect(f.fetch).not.toHaveBeenCalled()
})
it.each(['STRIPE_PORTAL_PERSONAL_CONFIGURATION', 'BASE_URL'] as const)('rejects missing %s', async key => {
  const f = await setup()
  expect((await openPortal('alice', { ...settings(), [key]: undefined })).status).toBe(503)
  expect(f.requests).toHaveLength(0)
})
it.each(['subscription_update', 'subscription_cancel'] as const)('rejects unverified %s capability', async feature => {
  const f = await setup(); f.configuration.features[feature].enabled = true
  expect((await openPortal()).status).toBe(503)
  expect(f.requests).toHaveLength(0)
})
it('rejects a different Stripe account', async () => {
  const f = await setup()
  await env.AQUILLA_PG.prepare("UPDATE workspace_checkout_attempts SET account_id = 'acct_other'").run()
  expect((await openPortal()).status).toBe(503)
  expect(f.requests).toHaveLength(0)
})
it('rejects a different subscription customer', async () => {
  const f = await setup(); f.paid.subscription.customer = 'cus_other'
  expect((await openPortal()).status).toBe(503)
  expect(f.requests).toHaveLength(0)
})
it.each([
  { customer: 'cus_other' }, { configuration: 'bpc_other' }, { livemode: true },
  { return_url: 'https://evil.test' }, { url: 'https://billing.stripe.com.evil.test/p' },
  { url: 'https://user@billing.stripe.com/p' }, { url: 'http://billing.stripe.com/p' },
])('rejects mismatched or unsafe Stripe session: %j', async override => {
  const f = await setup(); f.transform(session => ({ ...session, ...override }))
  const response = await openPortal()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'portal_unavailable' })
})
it('does not expose Stripe error details', async () => {
  await setup()
  vi.stubGlobal('fetch', async () => { throw new Error('sensitive upstream detail') })
  const response = await openPortal()
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('sensitive')
})
it('rejects a customer shared with legacy billing', async () => {
  const f = await setup()
  await env.AQUILLA_PG.prepare(`INSERT INTO org_billing (org_id, stripe_customer_id)
    VALUES (1, 'cus_rehearsal')`).run()
  expect((await openPortal()).status).toBe(409)
  expect(f.fetch).not.toHaveBeenCalled()
})
it('lets failed-payment customers reach payment methods without restoring access', async () => {
  await setup()
  await env.AQUILLA_PG.prepare('UPDATE workspace_subscription_state SET payment_failed = true').run()
  const before = await env.AQUILLA_PG.prepare('SELECT * FROM workspace_subscription_state').first()
  expect((await openPortal()).status).toBe(200)
  expect(await env.AQUILLA_PG.prepare('SELECT * FROM workspace_subscription_state').first()).toEqual(before)
})
it.each(['active', 'livemode'] as const)('rejects invalid configuration %s', async key => {
  const f = await setup(); f.configuration[key] = !f.configuration[key]
  expect((await openPortal()).status).toBe(503)
  expect(f.requests).toHaveLength(0)
})
