import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import { authHeader, jwtFor } from './helpers/db'
import { completedPayment, config } from './helpers/workspace-billing'
import type { Env } from '../types'

// AQU-2058: Team is the only paid offer, so the in-app plan-change review has
// nothing to change to. Monthly ↔ annual switches go through the Stripe portal
// (billing-native-lifecycle.test.ts). The review route stays gated and refuses
// every request without a Stripe preview until T18 (AQU-2071) deletes it.
const origin = 'http://127.0.0.1'
afterEach(() => vi.unstubAllGlobals())
async function review(offer: string, interval = 'year', user = 'alice', settings: Env = config(), extra = {}) {
  return app.request(`${origin}/api/v2/orgs/1/billing/change-rehearsal/review`, {
    method: 'POST', headers: authHeader(await jwtFor(user)),
    body: JSON.stringify({ offer, interval, quantity: 1, ...extra }),
  }, settings)
}
async function setup() {
  const payment = await completedPayment('team', 'year')
  expect((await payment.send()).status).toBe(200)
  const upstream = globalThis.fetch
  const previews: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === '/v1/invoices/create_preview') previews.push(url)
    return upstream(url, init)
  })
  return { previews }
}
it('refuses every Team plan change without a Stripe preview or a stored review', async () => {
  const f = await setup()
  expect((await review('team', 'year', 'bob')).status).toBe(403)
  expect((await review('team', 'year', 'alice', config(), { amountDueNow: 1 })).status).toBe(400)
  expect((await review('team', 'year', 'alice', config(), { quantity: 2 })).status).toBe(400)
  for (const offer of ['pro', 'max_5x', 'team_20x']) expect((await review(offer)).status).toBe(400)
  expect((await review('team')).status).toBe(409)
  expect((await review('team', 'month')).status).toBe(409)
  expect(f.previews).toHaveLength(0)
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM workspace_plan_change_reviews').first()).toEqual({ n: 0 })
})
it.each(['live_key', 'deployed', 'no_opt_in'])('keeps change review disabled for %s', async kind => {
  await setup()
  const settings = config()
  if (kind === 'live_key') settings.STRIPE_SECRET_KEY = 'sk_live_fixture'
  if (kind === 'deployed') settings.WRANGLER_LOCAL = undefined
  if (kind === 'no_opt_in') settings.BILLING_WORKSPACE_CHECKOUT_REHEARSAL = 'false'
  expect((await review('team', 'month', 'alice', settings)).status).toBe(503)
})
