import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import { authHeader, jwtFor } from './helpers/db'
import { completedPayment, config } from './helpers/workspace-billing'
import type { BillingChangeReview } from '../../../db/shared/billing-change-review'
import { stripeCatalogResponse } from './helpers/stripe-catalog'
import { reviewWorkspaceChange } from '../lib/billing/workspace-change-review'
import type { Env } from '../types'

const origin = 'http://127.0.0.1'
afterEach(() => vi.unstubAllGlobals())
async function review(offer: string, interval = 'year', user = 'alice', settings: Env = config(), extra = {}) {
  return app.request(`${origin}/api/v2/orgs/1/billing/change-rehearsal/review`, {
    method: 'POST', headers: authHeader(await jwtFor(user)),
    body: JSON.stringify({ offer, interval, quantity: 1, ...extra }),
  }, settings)
}
async function setup(offer = 'pro', interval = 'year') {
  const payment = await completedPayment(offer, interval)
  expect((await payment.send()).status).toBe(200)
  const upstream = globalThis.fetch
  const requests: URLSearchParams[] = []
  let transform = (value: Record<string, unknown>) => value
  let beforePreview = async () => {}
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname !== '/v1/invoices/create_preview') return upstream(url, init)
    expect(init?.method).toBe('POST')
    const params = new URLSearchParams(String(init?.body))
    requests.push(params)
    const start = Number(params.get('subscription_details[proration_date]'))
    const end = payment.subscription.items.data[0]!.current_period_end
    const targetPrices: string[] = []
    for (let i = 0; params.has(`subscription_details[items][${i}][price]`); i++) {
      targetPrices.push(params.get(`subscription_details[items][${i}][price]`)!)
    }
    const oldPrices = payment.subscription.items.data.map(item => item.price.id)
    const targetPrice = targetPrices.find(price => !oldPrices.includes(price))!
    expect(stripeCatalogResponse(`/v1/prices/${targetPrice}`).id).toBe(targetPrice)
    const oldPrice = oldPrices.find(price => !targetPrices.includes(price))
    // Stripe's returned amount deliberately differs from local calendar arithmetic.
    const lines = oldPrice ? [{ price: oldPrice, amount: -127 }, { price: targetPrice, amount: 492 }]
      : [{ price: targetPrice, amount: 365 }]
    const value = { id: 'upcoming_in_fixture', customer: payment.session.customer,
      livemode: false, currency: 'usd', amount_due: 365, total: 365, subtotal: 365,
      starting_balance: 0, parent: { subscription_details: { subscription: payment.subscription.id } },
      lines: { has_more: false, data: lines.map(line => ({ amount: line.amount, quantity: 1,
        period: { start, end }, pricing: { price_details: { price: line.price } },
        parent: { subscription_item_details: { subscription: payment.subscription.id, proration: true } },
      })) } }
    await beforePreview()
    return Response.json(transform(value))
  })
  return { payment, requests, transform: (fn: typeof transform) => { transform = fn },
    beforePreview: (fn: typeof beforePreview) => { beforePreview = fn } }
}
it.each(['month', 'year'])('persists the exact Stripe proration and server parameters for a %s upgrade', async interval => {
  const f = await setup('pro', interval)
  const before = await env.AQUILLA_PG.prepare('SELECT * FROM workspace_plan_entitlements').first()
  const response = await review('max_5x', interval)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const body = await response.json() as BillingChangeReview
  expect(body).toMatchObject({ direction: 'upgrade', currentOffer: 'pro', amountDueNow: 365,
    target: { offer: 'max_5x', interval }, changesEnabled: false })
  expect(f.requests[0]!.get('subscription_details[proration_behavior]')).toBe('always_invoice')
  expect(f.requests[0]!.get('subscription_details[billing_cycle_anchor]')).toBe('unchanged')
  expect(f.requests[0]!.get('subscription_details[items][0][id]')).toBe('si_line_0')
  expect(f.requests[0]!.get('subscription_details[payment_behavior]')).toBeNull()
  const saved = await env.AQUILLA_PG.prepare('SELECT review_json, request_params, source_json FROM workspace_plan_change_reviews WHERE id = ?')
    .bind(body.id).first<{ review_json: BillingChangeReview; request_params: Record<string, unknown>; source_json: { revision: number } }>()
  expect(saved!.review_json).toEqual(body)
  expect(saved!.request_params).toMatchObject({ payment_behavior: 'pending_if_incomplete',
    proration_behavior: 'always_invoice', proration_date: Date.parse(body.effectiveAt) / 1000 })
  expect(saved!.source_json.revision).toBe(1)
  expect(await env.AQUILLA_PG.prepare('SELECT * FROM workspace_plan_entitlements').first()).toEqual(before)
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_billing_events').first()).toEqual({ n: 1 })
})
it.each(['month', 'year'])('reviews a %s downgrade for renewal without reducing current access or previewing an immediate invoice', async interval => {
  const f = await setup('max_20x', interval)
  const response = await review('pro', interval)
  expect(response.status).toBe(200)
  const body = await response.json() as BillingChangeReview
  expect(body).toMatchObject({ direction: 'downgrade', currentOffer: 'max_20x', amountDueNow: 0 })
  expect(body.effectiveAt).toBe(new Date(f.payment.subscription.items.data[0]!.current_period_end * 1000).toISOString())
  expect(f.requests).toHaveLength(0)
  expect(await env.AQUILLA_PG.prepare('SELECT offer FROM workspace_plan_entitlements').first()).toEqual({ offer: 'max_20x' })
})
it('preserves the Team platform item when reviewing a Team 20× downgrade', async () => {
  const f = await setup('team_20x')
  const response = await review('team')
  expect(response.status).toBe(200)
  const body = await response.json() as BillingChangeReview
  const saved = await env.AQUILLA_PG.prepare('SELECT request_params FROM workspace_plan_change_reviews WHERE id = ?')
    .bind(body.id).first<{ request_params: Record<string, unknown> }>()
  expect(saved!.request_params).toMatchObject({ 'items[0][id]': 'si_line_0',
    'items[0][price]': f.payment.subscription.items.data[0]!.price.id,
    'items[1][id]': 'si_line_1', 'items[1][deleted]': 'true' })
})
it('rejects authorization, unsupported selection and browser-controlled amounts before Stripe preview', async () => {
  const f = await setup()
  expect((await review('max_5x', 'year', 'bob')).status).toBe(403)
  expect((await review('max_5x', 'year', 'alice', config(), { amountDueNow: 1 })).status).toBe(400)
  expect((await review('max_5x', 'year', 'alice', config(), { quantity: 2 })).status).toBe(400)
  expect((await review('team')).status).toBe(409)
  expect((await review('pro')).status).toBe(409)
  expect((await review('max_5x', 'month')).status).toBe(409)
  expect(f.requests).toHaveLength(0)
})
it.each(['live_key', 'deployed', 'no_opt_in'])('keeps change review disabled for %s', async kind => {
  await setup()
  const settings = config()
  if (kind === 'live_key') settings.STRIPE_SECRET_KEY = 'sk_live_fixture'
  if (kind === 'deployed') settings.WRANGLER_LOCAL = undefined
  if (kind === 'no_opt_in') settings.BILLING_WORKSPACE_CHECKOUT_REHEARSAL = 'false'
  expect((await review('max_5x', 'year', 'alice', settings)).status).toBe(503)
})
it.each(['failed', 'canceled', 'pending', 'scheduled', 'period', 'price', 'account'])(
  'rejects incompatible subscription %s before creating a review', async kind => {
    const f = await setup()
    if (kind === 'failed') await env.AQUILLA_PG.prepare('UPDATE workspace_subscription_state SET payment_failed = true').run()
    if (kind === 'canceled') f.payment.subscription.cancel_at_period_end = true
    if (kind === 'pending') Object.assign(f.payment.subscription, { pending_update: { expires_at: 123 } })
    if (kind === 'scheduled') Object.assign(f.payment.subscription, { schedule: 'sub_sched_existing' })
    if (kind === 'period') f.payment.subscription.items.data[0]!.current_period_end++
    if (kind === 'price') f.payment.subscription.items.data[0]!.price.id = 'price_unknown'
    if (kind === 'account') await env.AQUILLA_PG.prepare("UPDATE workspace_checkout_attempts SET account_id = 'acct_wrong'").run()
    expect((await review('max_5x')).status).toBe(kind === 'canceled' || kind === 'pending' || kind === 'scheduled' ? 503 : 409)
    expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_plan_change_reviews').first()).toEqual({ n: 0 })
  },
)
it.each(['identity', 'currency', 'extra_charge', 'balance', 'incomplete_lines', 'period', 'recurring'])(
  'rejects a Stripe preview with unsupported %s without persisting a review', async kind => {
    const f = await setup()
    f.transform(value => {
      const v = structuredClone(value) as any
      if (kind === 'identity') v.customer = 'cus_other'
      if (kind === 'currency') v.currency = 'cad'
      if (kind === 'extra_charge') v.amount_due++
      if (kind === 'balance') v.starting_balance = -100
      if (kind === 'incomplete_lines') v.lines.has_more = true
      if (kind === 'period') v.lines.data[0].period.start++
      if (kind === 'recurring') v.lines.data[0].parent.subscription_item_details.proration = false
      return v
    })
    expect((await review('max_5x')).status).toBe(['identity', 'extra_charge', 'period'].includes(kind) ? 409 : 503)
    expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_plan_change_reviews').first()).toEqual({ n: 0 })
  },
)
it('rejects a lifecycle change while Stripe calculates the preview', async () => {
  const f = await setup()
  f.beforePreview(async () => { await env.AQUILLA_PG.prepare('UPDATE workspace_subscription_state SET revision = revision + 1').run() })
  expect((await review('max_5x')).status).toBe(409)
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_plan_change_reviews').first()).toEqual({ n: 0 })
})
it('limits review validity to the current billing boundary', async () => {
  const f = await setup('max_20x')
  const end = f.payment.subscription.items.data[0]!.current_period_end
  const result = await reviewWorkspaceChange(config(), 1, { offer: 'pro', interval: 'year', quantity: 1 }, origin,
    new Date(end * 1000 - 1000))
  expect(result.expiresAt).toBe(result.effectiveAt)
})

it.each(['month', 'year'])('adds Team capacity once in a %s upgrade preview', async interval => {
  const f = await setup('team', interval)
  const response = await review('team_20x', interval)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ direction: 'upgrade', amountDueNow: 365 })
  const params = f.requests[0]!
  expect(params.get('subscription_details[items][0][id]')).toBe('si_line_0')
  expect(params.get('subscription_details[items][1][id]')).toBeNull()
  expect(params.get('subscription_details[items][1][quantity]')).toBe('1')
  expect(params.get('subscription_details[items][2][price]')).toBeNull()
})
