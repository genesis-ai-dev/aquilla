import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { recordInitialWorkspaceEntitlement } from '../lib/billing/workspace-entitlements'
import type { PriceCatalog, StripePriceInput } from '../lib/billing/pricing-model'
import app from '../index'
import type { Env } from '../types'
import { seedUser, jwtFor, authHeader } from './helpers/db'
import { stripeCatalogResponse } from './helpers/stripe-catalog'
import manifest from '../../../config/pricing/stripe-sandbox.json'
import type { BillingPlanReview } from '../../../db/shared/billing-review'

function config(): Env { return { ...env, WRANGLER_LOCAL: '1',
  BILLING_WORKSPACE_CHECKOUT_REHEARSAL: 'true', STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_PRICE_CATALOG: JSON.stringify(manifest), BASE_URL: 'http://127.0.0.1:5173' } }
async function setup(scope: 'personal' | 'team' = 'personal') {
  await seedUser(1, 'alice'); await seedUser(2, 'bob')
  const created = await app.request(scope === 'team' ? '/api/v2/orgs' : '/api/v2/orgs/me', {
    method: scope === 'team' ? 'POST' : 'GET', headers: authHeader(await jwtFor('alice')),
    ...(scope === 'team' ? { body: JSON.stringify({ name: 'Team' }) } : {}),
  }, env)
  expect(created.status).toBe(200)
  const sessions = new Map<string, Record<string, unknown>>()
  const requests: { key: string; body: string }[] = []
  let loseResponse = false
  let invalidUrl = false
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path === '/v1/checkout/sessions') {
      const key = new Headers(init?.headers).get('Idempotency-Key')!
      expect(key).toMatch(/^aquilla-workspace-/)
      expect(await env.AQUILLA_PG.prepare('SELECT jsonb_typeof(request_params) AS kind FROM workspace_checkout_attempts').first()).toEqual({ kind: 'object' })
      const params = new URLSearchParams(String(init?.body))
      expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_checkout_attempts').first()).toEqual({ n: 1 })
      requests.push({ key, body: params.toString() })
      if (!sessions.has(key)) sessions.set(key, { id: 'cs_test_123', mode: 'subscription',
        status: 'open', livemode: false, client_reference_id: params.get('client_reference_id'),
        metadata: { checkoutAttemptId: params.get('metadata[checkoutAttemptId]') },
        url: 'https://checkout.stripe.com/c/pay/cs_test_123' })
      if (loseResponse) { loseResponse = false; throw new Error('Connection lost after Stripe created session') }
      return Response.json({ ...sessions.get(key), ...(invalidUrl ? { url: 'https://evil.test/collect' } : {}) })
    }
    if (path.startsWith('/v1/checkout/sessions/')) return Response.json([...sessions.values()][0])
    return Response.json(stripeCatalogResponse(path))
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, sessions, requests, loseNextResponse: () => { loseResponse = true },
    useInvalidUrl: () => { invalidUrl = true } }
}
async function reviewed(offer = 'pro', interval = 'year') {
  const response = await app.request('http://127.0.0.1/api/v2/orgs/1/billing/review', {
    method: 'POST', headers: authHeader(await jwtFor('alice')),
    body: JSON.stringify({ offer, interval, quantity: 1 }),
  }, config())
  expect(response.status).toBe(200)
  const review = await response.json() as BillingPlanReview
  if (!review.ready) throw new Error('Expected eligible review')
  return { offer: review.offer.offer, interval: review.offer.interval, quantity: 1,
    confirmedPriceVersion: review.priceVersion, confirmedTotalAmount: review.offer.totalAmount,
    confirmedCurrency: review.offer.currency }
}
async function checkout(body: unknown, username = 'alice', settings = config(), origin = 'http://127.0.0.1') {
  return app.request(`${origin}/api/v2/orgs/1/billing/checkout-rehearsal`, {
    method: 'POST', headers: authHeader(await jwtFor(username)), body: JSON.stringify(body),
  }, settings)
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await env.AQUILLA_PG.exec('DROP TRIGGER IF EXISTS reject_checkout_save ON workspace_checkout_attempts')
  await env.AQUILLA_PG.exec('DROP FUNCTION IF EXISTS reject_checkout_save_fn()')
})
it.each(manifest.bindings.map(b => [b.offer, b.interval] as const))(
  'passes real review %s %s into approved checkout line items and metadata', async (offer, interval) => {
    const stripe = await setup(offer.startsWith('team') ? 'team' : 'personal')
    const input = await reviewed(offer, interval)
    const response = await checkout(input)
    expect(response.status).toBe(200)
    const body = await response.json() as { url: string; attemptId: string }
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
    const params = new URLSearchParams(stripe.requests[0]!.body)
    const components = offer === 'team_20x' ? ['team', 'team_20x'] : [offer]
    components.forEach((component, index) => {
      expect(params.get(`line_items[${index}][price]`)).toBe(manifest.bindings.find(b => b.offer === component && b.interval === interval)!.priceId)
      expect(params.get(`line_items[${index}][quantity]`)).toBe('1')
    })
    expect(params.get(`line_items[${components.length}][price]`)).toBeNull()
    expect(params.get('metadata[checkoutAttemptId]')).toBe(body.attemptId)
    expect(params.get('subscription_data[metadata][checkoutAttemptId]')).toBe(body.attemptId)
    expect(params.get('subscription_data[metadata][kind]')).toBe('workspace_plan_rehearsal')
    expect(params.get('success_url')).toBe('http://127.0.0.1:5173/orgs/1/settings/billing?checkout=rehearsal')
    expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_plan_entitlements').first()).toEqual({ n: 0 })
  },
)
it('retries an ambiguous Stripe response with the same durable key and exact parameters', async () => {
  const stripe = await setup()
  const input = await reviewed()
  stripe.loseNextResponse()
  expect((await checkout(input)).status).toBe(503)
  expect((await checkout(input)).status).toBe(200)
  expect(stripe.requests).toHaveLength(2)
  expect(stripe.requests[0]).toEqual(stripe.requests[1])
  expect(stripe.sessions.size).toBe(1)
})
it('serializes concurrent attempts and reuses a stored session on later access', async () => {
  const stripe = await setup()
  const input = await reviewed()
  const responses = await Promise.all([checkout(input), checkout(input)])
  expect(responses.map(response => response.status)).toEqual([200, 200])
  expect(await responses[0]!.json()).toEqual(await responses[1]!.json())
  expect(new Set(stripe.requests.map(request => request.key)).size).toBe(1)
  const posts = stripe.requests.length
  expect((await checkout(input)).status).toBe(200)
  expect(stripe.requests).toHaveLength(posts)
})
it('recovers after a database save failure following Stripe creation', async () => {
  const stripe = await setup()
  const input = await reviewed()
  await env.AQUILLA_PG.exec(`CREATE FUNCTION reject_checkout_save_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected save failure'; END $$`)
  await env.AQUILLA_PG.exec('CREATE TRIGGER reject_checkout_save BEFORE UPDATE ON workspace_checkout_attempts FOR EACH ROW EXECUTE FUNCTION reject_checkout_save_fn()')
  expect((await checkout(input)).status).toBe(503)
  await env.AQUILLA_PG.exec('DROP TRIGGER reject_checkout_save ON workspace_checkout_attempts')
  expect((await checkout(input)).status).toBe(200)
  expect(stripe.requests[0]).toEqual(stripe.requests[1])
  expect(stripe.sessions.size).toBe(1)
})
it('rejects stale totals, unauthorized users, and browser overrides before checkout', async () => {
  const stripe = await setup()
  const input = await reviewed()
  expect((await checkout(input, 'bob')).status).toBe(403)
  expect((await checkout({ ...input, confirmedTotalAmount: 1 })).status).toBe(409)
  expect((await checkout({ ...input, priceId: 'price_fake' })).status).toBe(400)
  expect((await checkout({ ...input, quantity: 2 })).status).toBe(400)
  expect(stripe.requests).toHaveLength(0)
})
it('does not switch offers or renew an old ambiguous attempt automatically', async () => {
  const stripe = await setup()
  const input = await reviewed()
  expect((await checkout(input)).status).toBe(200)
  expect((await checkout(await reviewed('max_5x'))).status).toBe(409)
  await env.AQUILLA_PG.prepare('UPDATE workspace_checkout_attempts SET expires_at = 1').run()
  expect((await checkout(input)).status).toBe(409)
  expect(stripe.requests).toHaveLength(1)
})
it('rechecks covered access and persisted pricing assignments', async () => {
  const stripe = await setup()
  const input = await reviewed()
  await env.AQUILLA_PG.prepare("INSERT INTO org_billing (org_id, plan, status) VALUES (1, 'enterprise', 'active')").run()
  expect((await checkout(input)).status).toBe(409)
  await env.AQUILLA_PG.prepare('DELETE FROM org_billing').run()
  await env.AQUILLA_PG.prepare("INSERT INTO billing_price_cohorts (org_id, experiment_key, variant, price_version) VALUES (1, 'other', 'other', 'different')").run()
  expect((await checkout(input)).status).toBe(409)
  expect(stripe.requests).toHaveLength(0)
})
it('refuses non-Stripe redirect URLs', async () => {
  const stripe = await setup()
  stripe.useInvalidUrl()
  expect((await checkout(await reviewed())).status).toBe(503)
})
it('keeps production, live keys, and missing rehearsal/local flags disabled', async () => {
  const stripe = await setup()
  const input = await reviewed()
  for (const overrides of [{ WRANGLER_LOCAL: undefined },
    { BILLING_WORKSPACE_CHECKOUT_REHEARSAL: undefined }, { STRIPE_SECRET_KEY: 'sk_live_fixture' }]) {
    expect((await checkout(input, 'alice', { ...config(), ...overrides })).status).toBe(503)
  }
  expect((await checkout(input, 'alice', config(), 'https://api.aquilla.app')).status).toBe(503)
  expect((await checkout(input, 'alice', { ...config(), BASE_URL: 'https://aquilla.app' })).status).toBe(503)
  expect(stripe.requests).toHaveLength(0)
})
it('never grants a legacy plan for signed rehearsal payment events', async () => {
  await setup()
  const metadata = { orgId: '1', kind: 'workspace_plan_rehearsal' }
  const cases: Array<[string, Record<string, unknown>]> = [
    ['checkout.session.completed', { metadata }],
    ['customer.subscription.updated', { metadata }],
    ['customer.subscription.deleted', { metadata }],
    ['invoice.paid', { parent: { subscription_details: { metadata } } }],
    ['invoice.paid', { subscription_details: { metadata } }],
  ]
  for (const [type, details] of cases) {
    const payload = JSON.stringify({ id: `evt_${type}`, type, data: { object: {
      id: 'sub_rehearsal', subscription: 'sub_rehearsal', customer: 'cus_rehearsal', status: 'active',
      ...details,
    } } })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', 'whsec_fixture').update(`${timestamp}.${payload}`).digest('hex')
    const response = await app.request('http://127.0.0.1/api/v2/billing/webhook', {
      method: 'POST', body: payload, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    }, { ...config(), STRIPE_WEBHOOK_SECRET: 'whsec_fixture' })
    expect(response.status).toBe(503)
  }
  for (const table of ['org_billing', 'org_billing_events', 'workspace_plan_entitlements']) {
    expect(await env.AQUILLA_PG.prepare(`SELECT count(*)::int AS n FROM ${table}`).first()).toEqual({ n: 0 })
  }
})

it('stores initial entitlement price IDs as a JSON array through the production adapter', async () => {
  await setup()
  const saved = await recordInitialWorkspaceEntitlement(env.AQUILLA_PG, {
    orgId: 1, catalog: manifest as PriceCatalog,
    prices: manifest.bindings.map(b => stripeCatalogResponse(`/v1/prices/${b.priceId}`) as StripePriceInput),
    offer: 'pro', interval: 'month', quantity: 1,
    subscriptionId: 'sub_initial', customerId: 'cus_initial',
    activatedAt: new Date(Date.now() - 1000).toISOString(),
  })
  const expected = manifest.bindings.find(b => b.offer === 'pro' && b.interval === 'month')!.priceId
  expect(saved.price_ids).toEqual([expected])
  expect(await env.AQUILLA_PG.prepare('SELECT jsonb_typeof(price_ids) AS kind FROM workspace_plan_entitlements').first())
    .toEqual({ kind: 'array' })
})
it('rechecks eligibility after reading prices and before saving the checkout request', async () => {
  const stripe = await setup()
  const input = await reviewed()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === '/v1/account') {
      await env.AQUILLA_PG.prepare("INSERT INTO org_billing (org_id, plan, status) VALUES (1, 'enterprise', 'active')").run()
    }
    return stripe.fetch(url, init)
  })
  expect((await checkout(input)).status).toBe(409)
  expect(stripe.requests).toHaveLength(0)
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_checkout_attempts').first()).toEqual({ n: 0 })
})
