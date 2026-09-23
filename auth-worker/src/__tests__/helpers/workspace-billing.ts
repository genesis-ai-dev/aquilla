import { env } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import app from '../../index'
import type { Env } from '../../types'
import type { StripePriceInput } from '../../lib/billing/pricing-model'
import { seedUser, jwtFor, authHeader } from './db'
import { stripeCatalogResponse } from './stripe-catalog'
import { testStripeCatalog as manifest } from './stripe-catalog'
import type { BillingPlanReview } from '../../../../db/shared/billing-review'

export function config(catalog = manifest): Env { return { ...env, WRANGLER_LOCAL: '1',
  BILLING_WORKSPACE_CHECKOUT_REHEARSAL: 'true', STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_PRICE_CATALOG: JSON.stringify(catalog), BASE_URL: 'http://127.0.0.1:5173' } }
export async function setup(scope: 'personal' | 'team' = 'personal', catalog = manifest) {
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
      expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_checkout_attempts WHERE resolved_at IS NULL').first()).toEqual({ n: 1 })
      requests.push({ key, body: params.toString() })
      if (!sessions.has(key)) sessions.set(key, { id: `cs_test_${123 + sessions.size}`, mode: 'subscription',
        status: 'open', livemode: false, client_reference_id: params.get('client_reference_id'),
        metadata: { checkoutAttemptId: params.get('metadata[checkoutAttemptId]') },
        url: `https://checkout.stripe.com/c/pay/cs_test_${123 + sessions.size}` })
      if (loseResponse) { loseResponse = false; throw new Error('Connection lost after Stripe created session') }
      return Response.json({ ...sessions.get(key), ...(invalidUrl ? { url: 'https://evil.test/collect' } : {}) })
    }
    if (path.startsWith('/v1/checkout/sessions/')) return Response.json([...sessions.values()].find(s => path.endsWith(`/${s.id}`)))
    return Response.json(stripeCatalogResponse(path, catalog))
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, sessions, requests, loseNextResponse: () => { loseResponse = true },
    useInvalidUrl: () => { invalidUrl = true } }
}
export async function reviewed(offer = 'pro', interval = 'year', catalog = manifest) {
  const response = await app.request('http://127.0.0.1/api/v2/orgs/1/billing/review', {
    method: 'POST', headers: authHeader(await jwtFor('alice')),
    body: JSON.stringify({ offer, interval, quantity: 1 }),
  }, config(catalog))
  expect(response.status).toBe(200)
  const review = await response.json() as BillingPlanReview
  if (!review.ready) throw new Error('Expected eligible review')
  return { offer: review.offer.offer, interval: review.offer.interval, quantity: 1,
    confirmedPriceVersion: review.priceVersion, confirmedTotalAmount: review.offer.totalAmount,
    confirmedCurrency: review.offer.currency }
}
export async function checkout(body: unknown, username = 'alice', settings = config(), origin = 'http://127.0.0.1') {
  return app.request(`${origin}/api/v2/orgs/1/billing/checkout-rehearsal`, {
    method: 'POST', headers: authHeader(await jwtFor(username)), body: JSON.stringify(body),
  }, settings)
}
export async function completedPayment(offer = 'pro', interval = 'year', catalog = manifest) {
  const stripe = await setup(offer.startsWith('team') ? 'team' : 'personal', catalog)
  expect((await checkout(await reviewed(offer, interval, catalog), 'alice', config(catalog))).status).toBe(200)
  const params = new URLSearchParams(stripe.requests[0]!.body)
  const metadata = Object.fromEntries([...params.entries()]
    .filter(([key]) => key.startsWith('metadata['))
    .map(([key, value]) => [key.slice(9, -1), value]))
  const items = []
  for (let i = 0; params.has(`line_items[${i}][price]`); i++) {
    items.push({ id: `si_line_${i}`, current_period_start: Math.floor(Date.now() / 1000) - 60,
      current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30, quantity: Number(params.get(`line_items[${i}][quantity]`)),
      price: stripeCatalogResponse(`/v1/prices/${params.get(`line_items[${i}][price]`)}`, catalog) as StripePriceInput })
  }
  const total = items.reduce((sum, item) => sum + item.price.unit_amount! * item.quantity, 0)
  const session = { id: 'cs_test_123', mode: 'subscription', status: 'complete',
    payment_status: 'paid', livemode: false, client_reference_id: params.get('client_reference_id')!,
    metadata, subscription: 'sub_rehearsal', customer: 'cus_rehearsal',
    currency: 'usd', amount_subtotal: total, amount_total: total }
  const subscription = { id: session.subscription, customer: session.customer,
    status: 'active', livemode: false, currency: 'usd', collection_method: 'charge_automatically',
    cancel_at_period_end: false, cancel_at: null, schedule: null, pending_update: null, latest_invoice: 'in_current',
    metadata: { ...metadata }, items: { has_more: false, data: items } }
  const invoice = { id: 'in_current', customer: session.customer, livemode: false,
    status: 'paid', paid: true, attempt_count: 1, amount_due: total,
    amount_paid: total, amount_remaining: 0, currency: 'usd',
    parent: { subscription_details: { subscription: subscription.id } },
    lines: { has_more: false, data: items.map(item => ({
      period: { start: item.current_period_start, end: item.current_period_end },
      pricing: { price_details: { price: item.price.id } },
    })) } }
  stripe.sessions.set(stripe.requests[0]!.key, session)
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname.startsWith('/v1/invoices/')) return Response.json(invoice)
    if (new URL(url).pathname.startsWith('/v1/subscriptions/')) return Response.json(subscription)
    return stripe.fetch(url, init)
  })
  const event = { id: 'evt_workspace_paid', type: 'checkout.session.completed', livemode: false,
    created: Math.floor(Date.now() / 1000) - 1, data: { object: structuredClone(session) } }
  const send = (settings: Env = { ...config(catalog), STRIPE_WEBHOOK_SECRET: 'whsec_fixture' }, signed = true) => {
    const body = JSON.stringify(event)
    const t = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', 'whsec_fixture').update(`${t}.${body}`).digest('hex')
    return app.request('http://127.0.0.1/api/v2/billing/webhook', { method: 'POST', body,
      headers: signed ? { 'stripe-signature': `t=${t},v1=${sig}` } : {} }, settings)
  }
  return { stripe, session, subscription, invoice, event, send }
}
