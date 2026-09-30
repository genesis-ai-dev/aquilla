import { env } from './helpers/pg-test-env'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import { seedUser, jwtFor, authHeader } from './helpers/db'
import { stripeCatalogResponse } from './helpers/stripe-catalog'
import manifest from '../../../config/pricing/stripe-sandbox.json'

const configured = { ...env, STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_PRICE_CATALOG: JSON.stringify(manifest) }
async function setup(scope: 'personal' | 'team' = 'personal') {
  await seedUser(1, 'alice'); await seedUser(2, 'bob')
  const created = await app.request(scope === 'team' ? '/api/v2/orgs' : '/api/v2/orgs/me', {
    method: scope === 'team' ? 'POST' : 'GET', headers: authHeader(await jwtFor('alice')),
    ...(scope === 'team' ? { body: JSON.stringify({ name: 'Chosen workspace' }) } : {}),
  }, env)
  expect(created.status).toBe(200)
  expect(await created.json()).toMatchObject({ id: 1 })
  const fetch = vi.fn(async (url: string | URL | Request) =>
    Response.json(stripeCatalogResponse(new URL(String(url)).pathname)))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
async function review(body: unknown, username = 'alice', orgId = '1') {
  return app.request(`/api/v2/orgs/${orgId}/billing/review`, {
    method: 'POST', headers: authHeader(await jwtFor(username)), body: JSON.stringify(body),
  }, configured)
}
afterEach(() => vi.unstubAllGlobals())

it.each(manifest.bindings.map(b => [b.offer, b.interval] as const))(
  'reviews approved %s %s with current Stripe prices without creating billing state',
  async (offer, interval) => {
    await setup(offer.startsWith('team') ? 'team' : 'personal')
    const response = await review({ offer, interval, quantity: 1 })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const data = await response.json() as { offer: { totalAmount: number } }
    expect(data).toMatchObject({ ready: true, checkoutEnabled: false,
      workspace: { orgId: 1 }, offer: { offer, interval } })
    if (offer === 'team_20x') expect(data.offer.totalAmount).toBe(interval === 'year' ? 720000 : 72000)
    expect(JSON.stringify(data)).not.toMatch(/price_1|weeklyAllowance|credits|stripe_customer/)
    for (const table of ['org_billing', 'workspace_plan_entitlements', 'org_billing_events', 'billing_price_cohorts']) {
      expect(await env.AQUILLA_PG.prepare(`SELECT count(*)::int AS n FROM ${table}`).first()).toEqual({ n: 0 })
    }
  },
)
it('rechecks workspace restrictions before contacting Stripe', async () => {
  const fetch = await setup('team')
  expect(await (await review({ offer: 'pro', interval: 'year', quantity: 1 })).json())
    .toMatchObject({ ready: false, reason: 'wrong_scope' })
  await env.AQUILLA_PG.prepare("INSERT INTO org_billing (org_id, plan, status) VALUES (1, 'enterprise', 'active')").run()
  expect(await (await review({ offer: 'team', interval: 'year', quantity: 1 })).json())
    .toMatchObject({ ready: false, reason: 'existing_billing' })
  expect(fetch).not.toHaveBeenCalled()
})
it('requires billing authority and rejects malformed selections or browser pricing', async () => {
  const fetch = await setup()
  const valid = { offer: 'pro', interval: 'year', quantity: 1 }
  expect((await review(valid, 'bob')).status).toBe(403)
  await env.AQUILLA_PG.prepare('INSERT INTO org_members (org_id, user_id, role_level) VALUES (1, 2, 400)').run()
  expect((await review(valid, 'bob')).status).toBe(403)
  for (const body of [{ ...valid, quantity: 2 }, { ...valid, offer: 'field' },
    { ...valid, interval: 'week' }, { ...valid, priceId: 'price_fake' },
    { ...valid, amount: 1 }, { ...valid, scope: 'team' }, { ...valid, cohort: 'cheap' }]) {
    expect((await review(body)).status).toBe(400)
  }
  expect((await review(valid, 'alice', '1oops')).status).toBe(400)
  expect(fetch).not.toHaveBeenCalled()
})
it('hides a previously available review when current Stripe validation fails', async () => {
  const fetch = await setup()
  const body = { offer: 'pro', interval: 'month', quantity: 1 }
  expect((await review(body)).status).toBe(200)
  fetch.mockResolvedValue(Response.json({ error: { message: 'sensitive upstream detail' } }, { status: 500 }))
  const response = await review(body)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'pricing_unavailable' })
})
