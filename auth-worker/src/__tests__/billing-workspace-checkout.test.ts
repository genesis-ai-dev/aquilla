import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { recordInitialWorkspaceEntitlement } from '../lib/billing/workspace-entitlements'
import type { PriceCatalog, StripePriceInput } from '../lib/billing/pricing-model'
import app from '../index'
import type { Env } from '../types'
import { jwtFor, authHeader } from './helpers/db'
import { stripeCatalogResponse } from './helpers/stripe-catalog'
import manifest from '../../../config/pricing/stripe-sandbox.json'
import { config, setup, reviewed, checkout, completedPayment } from './helpers/workspace-billing'

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
    }, { ...config(), BILLING_WORKSPACE_CHECKOUT_REHEARSAL: undefined, STRIPE_WEBHOOK_SECRET: 'whsec_fixture' })
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

// Real review → checkout parameters → Stripe-shaped payment → signed handler → DB.
async function expectNoPaymentGrant() {
  for (const table of ['org_billing', 'org_billing_events', 'workspace_plan_entitlements']) {
    expect(await env.AQUILLA_PG.prepare(`SELECT count(*)::int AS n FROM ${table}`).first()).toEqual({ n: 0 })
  }
}
it.each(manifest.bindings.map(b => [b.offer, b.interval] as const))(
  'activates %s %s and exposes its weekly plan only to its workspace', async (offer, interval) => {
    const payment = await completedPayment(offer, interval)
    expect((await payment.send()).status).toBe(200)
    const getWorkspace = async (org: number, user: string) => app.request(`/api/v2/orgs/${org}/billing/workspace`, {
      headers: authHeader(await jwtFor(user)),
    }, config())
    const response = await getWorkspace(1, 'alice')
    expect(response.status).toBe(200)
    const anchor = new Date(payment.event.created * 1000).toISOString()
    expect(await response.json()).toMatchObject({ orgId: 1,
      eligibility: { reason: 'already_subscribed', offers: [] },
      entitlement: { offer, billingInterval: interval, priceVersion: manifest.version, usagePeriodStart: anchor,
        usagePeriodEnd: new Date(payment.event.created * 1000 + 7 * 86400000).toISOString() },
      // A fresh paid week is measured at zero, with its exact reset instant.
      checkoutEnabled: false, usagePercent: 0,
      usageResetsAt: new Date(payment.event.created * 1000 + 7 * 86400000).toISOString() })
    expect((await getWorkspace(1, 'bob')).status).toBe(403)
    expect((await app.request('/api/v2/orgs/me', { headers: authHeader(await jwtFor('bob')) }, env)).status).toBe(200)
    expect(await (await getWorkspace(2, 'bob')).json()).toMatchObject({ entitlement: null })
    expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_billing').first()).toEqual({ n: 0 })
    expect(await (await payment.send()).json()).toEqual({ ok: true, duplicate: true })
    payment.event.id = 'evt_workspace_async_paid'
    payment.event.type = 'checkout.session.async_payment_succeeded'
    payment.event.created++
    expect((await payment.send()).status).toBe(200)
    expect(await (await getWorkspace(1, 'alice')).json()).toMatchObject({ entitlement: { usagePeriodStart: anchor } })
  },
)
it('serializes payment receipts and recovers a missing checkout session ID', async () => {
  const payment = await completedPayment()
  await env.AQUILLA_PG.prepare('UPDATE workspace_checkout_attempts SET session_id = NULL').run()
  const responses = await Promise.all([payment.send(), payment.send()])
  expect(responses.map(r => r.status)).toEqual([200, 200])
  expect(await Promise.all(responses.map(r => r.json()))).toContainEqual({ ok: true, duplicate: true })
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_plan_entitlements').first()).toEqual({ n: 1 })
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_billing_events').first()).toEqual({ n: 1 })
  expect(await env.AQUILLA_PG.prepare('SELECT session_id FROM workspace_checkout_attempts').first()).toEqual({ session_id: payment.session.id })
})
it.each(['workspace_plan_entitlements', 'org_billing_events', 'workspace_checkout_attempts'])(
  'rolls back payment when %s fails, then retries', async table => {
    const payment = await completedPayment()
    await env.AQUILLA_PG.prepare('UPDATE workspace_checkout_attempts SET session_id = NULL').run()
    await env.AQUILLA_PG.exec(`CREATE FUNCTION reject_payment_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected activation failure'; END $$`)
    await env.AQUILLA_PG.exec(`CREATE TRIGGER reject_payment BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_payment_fn()`)
    try {
      expect((await payment.send()).status).toBe(500)
      await expectNoPaymentGrant()
      expect(await env.AQUILLA_PG.prepare('SELECT session_id FROM workspace_checkout_attempts').first()).toEqual({ session_id: null })
    } finally {
      await env.AQUILLA_PG.exec(`DROP TRIGGER reject_payment ON ${table}`)
      await env.AQUILLA_PG.exec('DROP FUNCTION reject_payment_fn()')
    }
    expect((await payment.send()).status).toBe(200)
  },
)
it.each(['unpaid', 'wrong_customer', 'wrong_org', 'wrong_subscription', 'unknown_price',
  'changed_amount', 'changed_recurring_price', 'wrong_quantity', 'extra_item', 'missing_item',
  'truncated_items', 'live_session', 'live_subscription', 'live_event', 'inactive',
  'wrong_attempt', 'missing_metadata', 'future_event'])(
  'rejects %s without a receipt or plan', async fault => {
    const payment = await completedPayment('team_20x')
    const { session, subscription, event } = payment
    switch (fault) {
      case 'unpaid': session.payment_status = 'unpaid'; break
      case 'wrong_customer': subscription.customer = 'cus_other'; break
      case 'wrong_org': session.client_reference_id = '2'; break
      case 'wrong_subscription': subscription.id = 'sub_other'; break
      case 'unknown_price': subscription.items.data[0]!.price.id = 'price_unknown'; break
      case 'changed_amount': session.amount_total++; break
      case 'changed_recurring_price': subscription.items.data[0]!.price.unit_amount!++; break
      case 'wrong_quantity': subscription.items.data[0]!.quantity = 2; break
      case 'extra_item': subscription.items.data.push(subscription.items.data[0]!); break
      case 'missing_item': subscription.items.data.pop(); break
      case 'truncated_items': subscription.items.has_more = true; break
      case 'live_session': session.livemode = true; break
      case 'live_subscription': subscription.livemode = true; break
      case 'live_event': event.livemode = true; break
      case 'inactive': subscription.status = 'past_due'; break
      case 'wrong_attempt': session.metadata.checkoutAttemptId = crypto.randomUUID(); break
      case 'missing_metadata': delete subscription.metadata.orgId; break
      case 'future_event': event.created += 3600; break
    }
    expect((await payment.send()).status).toBe(500)
    await expectNoPaymentGrant()
  },
)
it('requires signatures even locally and rejects disabled or live configuration', async () => {
  const payment = await completedPayment()
  expect((await payment.send(undefined, false)).status).toBe(400)
  expect((await payment.send(config(), false)).status).toBe(503)
  for (const override of [{ STRIPE_SECRET_KEY: 'sk_live_fixture' },
    { WRANGLER_LOCAL: undefined }, { BILLING_WORKSPACE_CHECKOUT_REHEARSAL: undefined }]) {
    expect((await payment.send({ ...config(), STRIPE_WEBHOOK_SECRET: 'whsec_fixture', ...override })).status).toBe(503)
  }
  await expectNoPaymentGrant()
})
it('rejects a different Stripe account', async () => {
  const payment = await completedPayment()
  const original = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => new URL(url).pathname === '/v1/account'
    ? Promise.resolve(Response.json({ id: 'acct_other' })) : original(url, init))
  expect((await payment.send()).status).toBe(500)
  await expectNoPaymentGrant()
})
it('rechecks eligibility and pricing assignment at payment time', async () => {
  const payment = await completedPayment()
  await env.AQUILLA_PG.prepare("UPDATE organizations SET billing_scope = 'team' WHERE id = 1").run()
  expect((await payment.send()).status).toBe(500)
  await expectNoPaymentGrant()
  await env.AQUILLA_PG.prepare("UPDATE organizations SET billing_scope = 'personal' WHERE id = 1").run()
  await env.AQUILLA_PG.prepare("INSERT INTO billing_price_cohorts (org_id, experiment_key, variant, price_version) VALUES (1, 'other', 'other', 'different')").run()
  expect((await payment.send()).status).toBe(500)
  await expectNoPaymentGrant()
})
it('isolates lifecycle events when subscription metadata disappears', async () => {
  const payment = await completedPayment()
  expect((await payment.send()).status).toBe(200)
  payment.event.id = 'evt_workspace_updated'
  payment.event.type = 'customer.subscription.updated'
  payment.event.data.object.id = payment.subscription.id
  payment.event.data.object.metadata = {}
  expect((await payment.send()).status).toBe(200)
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_billing').first()).toEqual({ n: 0 })
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_billing_events').first()).toEqual({ n: 2 })
})
it('waits for paid async success instead of anchoring usage to an earlier unpaid completion', async () => {
  const payment = await completedPayment()
  payment.event.data.object.payment_status = 'unpaid'
  // Stripe now reports paid, but this signed completion predates payment.
  expect((await payment.send()).status).toBe(500)
  await expectNoPaymentGrant()
  payment.event.id = 'evt_delayed_success'
  payment.event.type = 'checkout.session.async_payment_succeeded'
  payment.event.data.object.payment_status = 'paid'
  expect((await payment.send()).status).toBe(200)
})
it('keeps Stripe read failures retryable without writing a receipt', async () => {
  const payment = await completedPayment()
  const original = globalThis.fetch
  vi.stubGlobal('fetch', () => Promise.reject(new Error('Stripe unavailable')))
  expect((await payment.send()).status).toBe(500)
  await expectNoPaymentGrant()
  vi.stubGlobal('fetch', original)
  expect((await payment.send()).status).toBe(200)
})

async function reconcileCheckout(user = 'alice', settings = config(), action = 'reconcile') {
  return app.request(`http://127.0.0.1/api/v2/orgs/1/billing/checkout-rehearsal/${action}`, {
    method: 'POST', headers: authHeader(await jwtFor(user)),
  }, settings)
}
it('replaces only confirmed expired checkout, keeping history and a new request key', async () => {
  const stripe = await setup()
  expect((await checkout(await reviewed())).status).toBe(200)
  const first = stripe.requests[0]!
  Object.assign(stripe.sessions.get(first.key)!, { status: 'expired', payment_status: 'unpaid', subscription: null })
  expect(await (await reconcileCheckout()).json()).toEqual({ status: 'expired' })
  expect(await (await reconcileCheckout()).json()).toEqual({ status: 'none' })
  expect((await checkout(await reviewed('max_5x'))).status).toBe(200)
  expect(stripe.requests[1]!.key).not.toBe(first.key)
  expect(stripe.sessions.size).toBe(2)
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_checkout_attempts').first()).toEqual({ n: 2 })
  expect(await env.AQUILLA_PG.prepare("SELECT resolution, resolved_at IS NOT NULL AS resolved FROM workspace_checkout_attempts WHERE session_id = 'cs_test_123'").first())
    .toEqual({ resolution: 'expired', resolved: true })
  await expectNoPaymentGrant()
})
it.each(['open', 'complete', 'unconfirmed', 'paid', 'wrong_account', 'wrong_workspace', 'live'])(
  'does not release %s checkout state', async fault => {
    const stripe = await setup()
    expect((await checkout(await reviewed())).status).toBe(200)
    const session = stripe.sessions.get(stripe.requests[0]!.key)!
    Object.assign(session, { status: 'expired', payment_status: 'unpaid', subscription: null })
    let status = 503
    if (fault === 'open' || fault === 'complete') { session.status = fault; status = 200 }
    if (fault === 'unconfirmed') {
      await env.AQUILLA_PG.prepare('UPDATE workspace_checkout_attempts SET session_id = NULL').run()
      status = 409
    }
    if (fault === 'paid') session.payment_status = 'paid'
    if (fault === 'wrong_workspace') session.client_reference_id = '2'
    if (fault === 'live') session.livemode = true
    if (fault === 'wrong_account') {
      const original = globalThis.fetch
      vi.stubGlobal('fetch', (url: string, init?: RequestInit) => new URL(url).pathname === '/v1/account'
        ? Promise.resolve(Response.json({ id: 'acct_other' })) : original(url, init))
    }
    const response = await reconcileCheckout()
    expect(response.status).toBe(status)
    if (status === 200) expect(await response.json()).toEqual({ status: fault === 'open' ? 'open' : 'payment_pending' })
    expect(await env.AQUILLA_PG.prepare('SELECT resolution, resolved_at FROM workspace_checkout_attempts').first())
      .toEqual({ resolution: null, resolved_at: null })
    expect(stripe.requests).toHaveLength(1)
  },
)
it('requires billing authority and local test configuration for reconciliation', async () => {
  const stripe = await setup()
  expect((await checkout(await reviewed())).status).toBe(200)
  const calls = stripe.fetch.mock.calls.length
  expect((await reconcileCheckout('bob')).status).toBe(403)
  expect((await reconcileCheckout('alice', { ...config(), STRIPE_SECRET_KEY: 'sk_live_fixture' })).status).toBe(503)
  expect(stripe.fetch.mock.calls).toHaveLength(calls)
})
it('serializes concurrent expiry confirmations without deleting history', async () => {
  const stripe = await setup()
  expect((await checkout(await reviewed())).status).toBe(200)
  Object.assign(stripe.sessions.get(stripe.requests[0]!.key)!, { status: 'expired', payment_status: 'unpaid', subscription: null })
  const responses = await Promise.all([reconcileCheckout(), reconcileCheckout()])
  expect(responses.map(r => r.status)).toEqual([200, 200])
  expect(await Promise.all(responses.map(r => r.json()))).toContainEqual({ status: 'expired' })
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_checkout_attempts').first()).toEqual({ n: 1 })
})
it('rolls back expiry resolution on a database failure and permits retry', async () => {
  const stripe = await setup()
  expect((await checkout(await reviewed())).status).toBe(200)
  Object.assign(stripe.sessions.get(stripe.requests[0]!.key)!, { status: 'expired', payment_status: 'unpaid', subscription: null })
  await env.AQUILLA_PG.exec(`CREATE FUNCTION reject_checkout_save_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected resolution failure'; END $$`)
  await env.AQUILLA_PG.exec('CREATE TRIGGER reject_checkout_save BEFORE UPDATE ON workspace_checkout_attempts FOR EACH ROW EXECUTE FUNCTION reject_checkout_save_fn()')
  expect((await reconcileCheckout()).status).toBe(503)
  expect(await env.AQUILLA_PG.prepare('SELECT resolution FROM workspace_checkout_attempts').first()).toEqual({ resolution: null })
  await env.AQUILLA_PG.exec('DROP TRIGGER reject_checkout_save ON workspace_checkout_attempts')
  expect(await (await reconcileCheckout()).json()).toEqual({ status: 'expired' })
})
it('rejects payment for a resolved attempt without a receipt or entitlement', async () => {
  const payment = await completedPayment()
  await env.AQUILLA_PG.prepare("UPDATE workspace_checkout_attempts SET resolution = 'expired', resolved_at = now()").run()
  expect((await payment.send()).status).toBe(500)
  await expectNoPaymentGrant()
})

it.each([false, true])('abandons an open checkout and recovers a lost expiry response: %s', async loseResponse => {
  const stripe = await setup()
  expect((await checkout(await reviewed())).status).toBe(200)
  const session = stripe.sessions.get(stripe.requests[0]!.key)!
  const expireKeys: string[] = []
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname.endsWith('/expire')) {
      expect(init?.method).toBe('POST')
      expireKeys.push(new Headers(init?.headers).get('Idempotency-Key')!)
      Object.assign(session, { status: 'expired', payment_status: 'unpaid', subscription: null })
      if (loseResponse) throw new Error('Response lost after successful expiry')
      return Response.json(session)
    }
    return original(url, init)
  })
  const response = await reconcileCheckout('alice', config(), 'expire')
  expect(response.status).toBe(loseResponse ? 503 : 200)
  if (loseResponse) {
    expect(await env.AQUILLA_PG.prepare('SELECT resolution FROM workspace_checkout_attempts').first()).toEqual({ resolution: null })
    expect(await (await reconcileCheckout('alice', config(), 'expire')).json()).toEqual({ status: 'expired' })
  }
  expect(expireKeys).toHaveLength(1)
  expect(expireKeys[0]).toMatch(/^aquilla-workspace-expire-/)
  expect(await env.AQUILLA_PG.prepare('SELECT resolution FROM workspace_checkout_attempts').first()).toEqual({ resolution: 'expired' })
  await expectNoPaymentGrant()
})
it('never expires a completed checkout or permits another user to abandon it', async () => {
  const payment = await completedPayment()
  const calls: string[] = []
  const original = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') calls.push(url)
    return original(url, init)
  })
  expect((await reconcileCheckout('bob', config(), 'expire')).status).toBe(403)
  expect(await (await reconcileCheckout('alice', config(), 'expire')).json()).toEqual({ status: 'payment_pending' })
  expect(calls).toEqual([])
  expect((await payment.send()).status).toBe(200)
})

async function lifecycleWorkspace() {
  const response = await app.request('/api/v2/orgs/1/billing/workspace', {
    headers: authHeader(await jwtFor('alice')),
  }, config())
  expect(response.status).toBe(200)
  return response.json() as Promise<import('../../../db/shared/billing-workspace').BillingWorkspace>
}
function lifecycleEvent(payment: Awaited<ReturnType<typeof completedPayment>>, type: string, id: string) {
  payment.event.type = type
  payment.event.id = id
  Object.assign(payment.event.data.object, type.startsWith('invoice.')
    ? structuredClone(payment.invoice) : structuredClone(payment.subscription))
}
it('falls back to Free on failure and restores paid access without resetting the usage week', async () => {
  const p = await completedPayment('max_20x')
  expect((await p.send()).status).toBe(200)
  const initial = (await lifecycleWorkspace()).entitlement!
  p.invoice.paid = false; p.invoice.status = 'open'; p.invoice.amount_remaining = p.invoice.amount_due
  p.invoice.amount_paid = 0
  // Stripe can remain active after some payment failures; invoice state matters.
  lifecycleEvent(p, 'invoice.payment_failed', 'evt_failed')
  expect((await p.send()).status).toBe(200)
  expect((await lifecycleWorkspace()).entitlement).toMatchObject({
    offer: 'max_20x', usagePeriodStart: initial.usagePeriodStart,
    access: { offer: 'free', reason: 'payment_failed' },
  })
  p.invoice.paid = true; p.invoice.status = 'paid'; p.invoice.amount_remaining = 0
  p.invoice.amount_paid = p.invoice.amount_due
  lifecycleEvent(p, 'invoice.paid', 'evt_recovered')
  expect((await p.send()).status).toBe(200)
  expect((await lifecycleWorkspace()).entitlement).toMatchObject({
    usagePeriodStart: initial.usagePeriodStart, access: { offer: 'max_20x', reason: 'paid' },
  })
  // A delayed failed event reads the paid invoice, rather than revoking recovered access.
  lifecycleEvent(p, 'invoice.payment_failed', 'evt_old_failure')
  expect((await p.send()).status).toBe(200)
  expect((await lifecycleWorkspace()).entitlement!.access!.offer).toBe('max_20x')
  expect(await (await p.send()).json()).toEqual({ ok: true, duplicate: true })
})
it('retains already-paid access when canceled, then falls back at the exact paid boundary', async () => {
  const p = await completedPayment()
  expect((await p.send()).status).toBe(200)
  const initial = (await lifecycleWorkspace()).entitlement!
  p.subscription.cancel_at_period_end = true
  lifecycleEvent(p, 'customer.subscription.updated', 'evt_cancel_scheduled')
  expect((await p.send()).status).toBe(200)
  expect((await lifecycleWorkspace()).entitlement!.access).toMatchObject({ offer: 'pro', cancelAtPeriodEnd: true })
  p.subscription.status = 'canceled'
  p.subscription.items.data[0]!.current_period_end = Math.floor(Date.now() / 1000)
  lifecycleEvent(p, 'customer.subscription.deleted', 'evt_canceled')
  expect((await p.send()).status).toBe(200)
  expect((await lifecycleWorkspace()).entitlement!.access!.paidThrough).toBe(initial.access!.paidThrough)
  const { readBillingWorkspace } = await import('../lib/billing/workspace')
  const ended = await readBillingWorkspace(env.AQUILLA_PG, 1, new Date(initial.access!.paidThrough))
  expect(ended!.entitlement!.access).toMatchObject({ offer: 'free', reason: 'paid_period_ended' })
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_billing').first()).toEqual({ n: 0 })
})
it('extends a paid renewal without changing the weekly usage anchor', async () => {
  const p = await completedPayment()
  expect((await p.send()).status).toBe(200)
  const initial = (await lifecycleWorkspace()).entitlement!
  const item = p.subscription.items.data[0]!
  item.current_period_start = item.current_period_end
  item.current_period_end += 86400 * 30
  p.invoice.lines.data[0]!.period.start = item.current_period_start
  p.invoice.lines.data[0]!.period.end = item.current_period_end
  lifecycleEvent(p, 'invoice.paid', 'evt_renewal')
  const { reconcileWorkspaceLifecycle } = await import('../lib/billing/workspace-lifecycle')
  await reconcileWorkspaceLifecycle(config(), p.event, p.event.data.object,
    new Date(item.current_period_start * 1000 + 1000))
  const next = (await lifecycleWorkspace()).entitlement!
  expect(next.usagePeriodStart).toBe(initial.usagePeriodStart)
  expect(Date.parse(next.access!.paidThrough)).toBe(Date.parse(initial.access!.paidThrough) + 86400000 * 30)
})
it.each(['account', 'customer', 'live', 'price', 'invoice_subscription', 'invoice_period'])(
  'rejects unverified lifecycle %s without consuming its receipt', async field => {
    const p = await completedPayment()
    expect((await p.send()).status).toBe(200)
    if (field === 'account') Object.assign(p.event, { account: 'acct_other' })
    if (field === 'customer') p.subscription.customer = 'cus_other'
    if (field === 'live') p.subscription.livemode = true
    if (field === 'price') p.subscription.items.data[0]!.price.id = 'price_other'
    if (field === 'invoice_subscription') p.invoice.parent.subscription_details.subscription = 'sub_other'
    if (field === 'invoice_period') p.invoice.lines.data[0]!.period.end++
    lifecycleEvent(p, 'invoice.paid', 'evt_invalid_lifecycle')
    expect((await p.send()).status).toBe(500)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM org_billing_events WHERE stripe_event_id = 'evt_invalid_lifecycle'").first()).toEqual({ n: 0 })
  },
)
it('rolls back a lifecycle receipt on storage failure and permits retry', async () => {
  const p = await completedPayment()
  expect((await p.send()).status).toBe(200)
  lifecycleEvent(p, 'customer.subscription.updated', 'evt_lifecycle_retry')
  await env.AQUILLA_PG.exec(`CREATE FUNCTION reject_lifecycle_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected state failure'; END $$`)
  await env.AQUILLA_PG.exec('CREATE TRIGGER reject_lifecycle BEFORE UPDATE ON workspace_subscription_state FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_fn()')
  try {
    expect((await p.send()).status).toBe(500)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM org_billing_events WHERE stripe_event_id = 'evt_lifecycle_retry'").first()).toEqual({ n: 0 })
  } finally {
    await env.AQUILLA_PG.exec('DROP TRIGGER reject_lifecycle ON workspace_subscription_state')
    await env.AQUILLA_PG.exec('DROP FUNCTION reject_lifecycle_fn()')
  }
  expect((await p.send()).status).toBe(200)
})
it('rejects a stale concurrent Stripe read and retries it against the recovered state', async () => {
  const p = await completedPayment()
  expect((await p.send()).status).toBe(200)
  const originalFetch = globalThis.fetch
  let arrived!: () => void
  let resume!: () => void
  const blocked = new Promise<void>(resolve => { arrived = resolve })
  const released = new Promise<void>(resolve => { resume = resolve })
  let first = true
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (first && new URL(url).pathname.startsWith('/v1/subscriptions/')) {
      first = false
      const stale = { ...structuredClone(p.subscription), status: 'past_due' }
      arrived()
      await released
      return Response.json(stale)
    }
    return originalFetch(url, init)
  })
  lifecycleEvent(p, 'invoice.payment_failed', 'evt_concurrent_failure')
  const oldRequest = p.send()
  await blocked
  lifecycleEvent(p, 'invoice.paid', 'evt_concurrent_recovery')
  try { expect((await p.send()).status).toBe(200) } finally { resume() }
  expect((await oldRequest).status).toBe(500)
  expect((await lifecycleWorkspace()).entitlement!.access!.offer).toBe('pro')
  expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM org_billing_events WHERE stripe_event_id = 'evt_concurrent_failure'").first()).toEqual({ n: 0 })
  lifecycleEvent(p, 'invoice.payment_failed', 'evt_concurrent_failure')
  expect((await p.send()).status).toBe(200)
  expect((await lifecycleWorkspace()).entitlement!.access!.offer).toBe('pro')
})
it('does not clear a failed cancellation using an invoice for a different paid period', async () => {
  const p = await completedPayment()
  expect((await p.send()).status).toBe(200)
  p.subscription.status = 'past_due'
  lifecycleEvent(p, 'customer.subscription.updated', 'evt_past_due')
  expect((await p.send()).status).toBe(200)
  p.subscription.status = 'canceled'
  p.invoice.lines.data[0]!.period.end++
  lifecycleEvent(p, 'customer.subscription.deleted', 'evt_wrong_canceled_invoice')
  expect((await p.send()).status).toBe(500)
  expect((await lifecycleWorkspace()).entitlement!.access!.reason).toBe('payment_failed')
})
