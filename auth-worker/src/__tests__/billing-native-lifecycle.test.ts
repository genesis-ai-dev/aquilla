import { createHmac } from 'node:crypto'
import app from '../index'
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import frames from './fixtures/stripe-native-lifecycle.json'
import nativeManifest from '../../../config/pricing/stripe-sandbox-native.json'
import { catalogSchema } from '../lib/billing/catalog-schema'
import { completedPayment, config } from './helpers/workspace-billing'
import { reconcileWorkspaceLifecycle } from '../lib/billing/workspace-lifecycle'
import { readBillingWorkspace, readWorkspaceEntitlement, readWorkspaceSubscriptionState } from '../lib/billing/workspace'
const catalog = catalogSchema.parse(nativeManifest)
const now = new Date((frames.initial.subscription.items.data[0]!.current_period_start + 3600) * 1000)
// Checkout activation and fixture reconciliation must share one clock. A real
// wall clock eventually puts activation after the recorded lifecycle events.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function frame(phase: keyof typeof frames) {
  // Preserve actual Stripe fields/absence, adapting only our isolated test identity.
  return JSON.parse(JSON.stringify(frames[phase])
    .replaceAll(frames.initial.subscription.id, 'sub_rehearsal')
    .replaceAll(frames.initial.subscription.customer, 'cus_rehearsal')) as {
      subscription: Record<string, unknown>; invoice: Record<string, unknown>
    }
}
async function setup(activate = true) {
  const paid = await completedPayment('pro', 'month', catalog)
  let current = frame('initial')
  Object.assign(paid.subscription, current.subscription)
  const upstream = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path.startsWith('/v1/subscriptions/')) return Response.json({
      ...current.subscription, metadata: paid.subscription.metadata,
    })
    if (path.startsWith('/v1/invoices/')) return Response.json(current.invoice)
    return upstream(url, init)
  })
  if (activate) expect((await paid.send()).status).toBe(200)
  let n = 0
  return { activate: paid.send, send: (id: string, type = 'customer.subscription.updated') => {
    const body = JSON.stringify({ id, type, livemode: false,
      created: Math.floor(Date.now() / 1000) - 1,
      data: { object: type.startsWith('invoice.') ? { ...current.invoice,
        parent: { subscription_details: { subscription: paid.subscription.id,
          metadata: paid.subscription.metadata } },
      } : { ...current.subscription, metadata: paid.subscription.metadata } } })
    const t = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', 'whsec_fixture').update(`${t}.${body}`).digest('hex')
    return app.request('http://127.0.0.1/api/v2/billing/webhook', { method: 'POST', body,
      headers: { 'stripe-signature': `t=${t},v1=${signature}` },
    }, { ...config(catalog), STRIPE_WEBHOOK_SECRET: 'whsec_fixture' })
  }, select: (phase: keyof typeof frames) => { current = frame(phase); return current },
    apply: () => reconcileWorkspaceLifecycle(config(catalog), {
      id: `evt_native_${++n}`, type: 'customer.subscription.updated', livemode: false,
      created: Math.floor(now.getTime() / 1000) - 1,
    }, current.subscription, now) }
}
it('reconciles real paid upgrade, credit downgrade, and flexible cancellation without resetting usage', async () => {
  const f = await setup()
  expect(frames.initial.invoice).not.toHaveProperty('paid')
  await f.apply()
  const anchor = (await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!.usage_anchor
  for (const [phase, offer] of [['upgrade', 'max_5x'], ['downgrade', 'pro'], ['cancellation', 'pro']] as const) {
    f.select(phase); await f.apply()
    const stored = await readWorkspaceEntitlement(env.AQUILLA_PG, 1)
    expect(stored).toMatchObject({ offer, usage_anchor: anchor, quantity: 1, billing_interval: 'month' })
    expect(stored!.price_ids).toHaveLength(1)
    expect((await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1))!.payment_failed).toBe(false)
  }
  expect(frames.cancellation.subscription.cancel_at_period_end).toBe(false)
  expect(frames.cancellation.subscription.cancel_at).toBeGreaterThan(0)
  expect((await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1))!.cancel_at_period_end).toBe(true)
  expect((await readBillingWorkspace(env.AQUILLA_PG, 1, now))!.entitlement!.offer).toBe('pro')
})
it('does not grant an upgrade when its invoice remains unpaid', async () => {
  const f = await setup(); const current = f.select('upgrade')
  Object.assign(current.invoice, { status: 'open', amount_paid: 0, amount_remaining: 4000, attempt_count: 1 })
  current.subscription.status = 'past_due'
  await f.apply()
  expect((await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!.offer).toBe('pro')
  expect((await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1))!.payment_failed).toBe(true)
})
it.each(['wrong_period', 'missing_proration', 'wrong_subscription', 'extra_charge'])('rejects invalid paid proof: %s', async kind => {
  const f = await setup(); const current = f.select('upgrade')
  const lines = current.invoice.lines as typeof frames.upgrade.invoice.lines
  const line = lines.data[1]!
  if (kind === 'wrong_period') line.period.end += 1
  if (kind === 'missing_proration') line.parent.subscription_item_details.proration = false
  if (kind === 'wrong_subscription') line.parent.subscription_item_details.subscription = 'sub_other'
  if (kind === 'extra_charge') lines.data[0]!.amount = 1
  const before = await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1)
  await expect(f.apply()).rejects.toThrow()
  expect(await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1)).toEqual(before)
  expect((await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!.offer).toBe('pro')
})
it('rolls back the plan mutation when the subscription-state write fails', async () => {
  const f = await setup(); f.select('upgrade')
  const before = await readWorkspaceEntitlement(env.AQUILLA_PG, 1)
  await env.AQUILLA_PG.exec('ALTER TABLE workspace_subscription_state ADD CONSTRAINT native_test_revision CHECK (revision < 2)')
  try {
    await expect(f.apply()).rejects.toThrow()
    expect(await readWorkspaceEntitlement(env.AQUILLA_PG, 1)).toEqual(before)
  } finally {
    await env.AQUILLA_PG.exec('ALTER TABLE workspace_subscription_state DROP CONSTRAINT native_test_revision')
  }
})

it('retries an invoice delivered before Checkout and deduplicates its successful replay', async () => {
  const f = await setup(false)
  expect((await f.send('evt_native_early', 'invoice.paid')).status).toBe(500)
  expect(await readWorkspaceEntitlement(env.AQUILLA_PG, 1)).toBeNull()
  expect((await f.activate()).status).toBe(200)
  const anchor = (await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!.usage_anchor
  expect((await f.send('evt_native_early', 'invoice.paid')).status).toBe(200)
  const state = await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1)
  expect((await f.send('evt_native_early', 'invoice.paid')).status).toBe(200)
  expect(await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1)).toEqual(state)
  expect((await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!.usage_anchor).toBe(anchor)
})
it('retries overlapping native upgrade events after a revision conflict without duplicate effects', async () => {
  const f = await setup(); f.select('upgrade')
  const anchor = (await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!.usage_anchor
  const upstream = globalThis.fetch
  let arrived = 0
  let release!: () => void
  const bothRead = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname.startsWith('/v1/invoices/') && arrived < 2) {
      arrived += 1
      if (arrived === 2) release()
      await bothRead
    }
    return upstream(url, init)
  })
  const ids = ['evt_native_overlap_invoice', 'evt_native_overlap_subscription']
  const types = ['invoice.paid', 'customer.subscription.updated']
  const results = await Promise.all(ids.map((id, index) => f.send(id, types[index])))
  expect(results.map(r => r.status).sort()).toEqual([200, 500])
  const failed = results.findIndex(r => r.status === 500)
  expect((await f.send(ids[failed]!, types[failed])).status).toBe(200)
  const state = await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1)
  for (let i = 0; i < ids.length; i++) expect((await f.send(ids[i]!, types[i])).status).toBe(200)
  expect(await readWorkspaceSubscriptionState(env.AQUILLA_PG, 1)).toEqual(state)
  expect(await readWorkspaceEntitlement(env.AQUILLA_PG, 1)).toMatchObject({ offer: 'max_5x', usage_anchor: anchor })
})
