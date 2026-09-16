import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { completedPayment, config } from './helpers/workspace-billing'
import { authHeader, jwtFor } from './helpers/db'
import { readUsageTotals } from '../lib/billing/workspace-usage'
import { readBillingWorkspace } from '../lib/billing/workspace'
import { resetRateCardCache } from '../lib/billing/rate-card'
import { rateCard, withRateCard } from './helpers/rate-card'

afterEach(() => { vi.unstubAllGlobals(); resetRateCardCache() })
async function setup() {
  const paid = await completedPayment('pro', 'month')
  expect((await paid.send()).status).toBe(200)
  await env.AQUILLA_PG.exec("INSERT INTO projects (id, name, org_id, created_by) VALUES ('chat-project', 'Chat', 1, 1)")
  const settings: Env = { ...config(), OPENROUTER_API_KEY: 'local-fixture', AI_ALLOWED_MODELS: 'local-test',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1', BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  const headers = { ...authHeader(await jwtFor('alice')), 'Idempotency-Key': crypto.randomUUID() }
  const send = (extra: Record<string, unknown> = {}, overrides: Partial<Env> = {}, id = headers['Idempotency-Key']) => app.request(
    'http://127.0.0.1/api/v1/chat/completions', { method: 'POST', headers: { ...headers, 'Idempotency-Key': id },
      body: JSON.stringify({ model: 'local-test', projectId: 'chat-project', messages: [{ role: 'user', content: 'Hello' }], ...extra }),
    }, { ...settings, ...overrides })
  const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  const period = { start: plan.usagePeriodStart, end: plan.usagePeriodEnd }
  const totals = () => readUsageTotals(env.AQUILLA_PG, 1, period)
  return { settings, send, totals }
}
const completions = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => String(url).includes('/chat/completions')).length
function upstream(text: string, stream = false) {
  return withRateCard(vi.fn(async () => new Response(text, { headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } })))
}
it('passes real authenticated chat output through cost settlement and blocks duplicate execution', async () => {
  const f = await setup()
  const body = { choices: [{ message: { content: 'Hello back' } }], usage: { cost: 0.00125 } }
  const fetch = upstream(JSON.stringify(body)); vi.stubGlobal('fetch', fetch)
  const response = await f.send()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(body)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('settled')
  expect((await f.totals()).settled).toBe(500_000)
  // The billing API reports the same ledger: 0.5 of 50 units rounds down to 1%.
  const workspace = await (await app.request('http://127.0.0.1/api/v2/orgs/1/billing/workspace',
    { headers: authHeader(await jwtFor('alice')) }, f.settings)).json() as { usagePercent: number | null; usageResetsAt?: string }
  expect(workspace.usagePercent).toBe(1)
  expect(workspace.usageResetsAt).toBe((await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!.usagePeriodEnd)
  expect((await f.send()).status).toBe(409)
  expect(completions(fetch)).toBe(1)
})
it('preserves streamed bytes across arbitrary chunk boundaries and settles only at completion', async () => {
  const f = await setup()
  const text = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\r\n\r\ndata: {"usage":{"cost":0.0025}}\r\n\r\ndata: [DONE]\r\n\r\n'
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  vi.stubGlobal('fetch', withRateCard(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset)) },
  })))))
  const response = await f.send({ stream: true })
  expect(response.status).toBe(200)
  expect((await f.totals()).reserved).toBe(1_562_500)
  expect(await response.text()).toBe(text)
  expect(await f.totals()).toEqual({ reserved: 0, settled: 1_000_000, committed: 1_000_000 })
})
it.each(['missing', 'truncated', 'malformed', 'oversized'])('retains uncertain %s stream cost', async kind => {
  const f = await setup()
  const text = kind === 'missing' ? 'data: {"choices":[]}\n\ndata: [DONE]\n\n'
    : kind === 'truncated' ? 'data: {"usage":{"cost":0.001}}\n\n'
    : kind === 'malformed' ? 'data: {"usage":{"cost":-1}}\n\ndata: [DONE]\n\n'
    : `data: ${'x'.repeat(70000)}\n\ndata: [DONE]\n\n`
  vi.stubGlobal('fetch', upstream(text, true))
  const response = await f.send({ stream: true })
  expect(await response.text()).toBe(text)
  expect((await f.totals()).reserved).toBe(1_562_500)
  expect((await f.totals()).settled).toBe(0)
})
it('keeps the reservation after client cancellation and cancels the provider reader', async () => {
  const f = await setup(); const canceled = vi.fn()
  vi.stubGlobal('fetch', withRateCard(vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n')) }, cancel: canceled,
  })))))
  const response = await f.send({ stream: true })
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel()
  expect(canceled).toHaveBeenCalledTimes(1)
  expect((await f.totals()).reserved).toBe(1_562_500)
})
it('returns valid content with pending accounting when provider cost is missing', async () => {
  const f = await setup(); const body = { choices: [{ message: { content: 'Saved answer' } }] }
  vi.stubGlobal('fetch', upstream(JSON.stringify(body)))
  const response = await f.send()
  expect(await response.json()).toEqual(body)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('pending')
  expect((await f.totals()).reserved).toBe(1_562_500)
})
it('blocks exhausted allowance before starting the provider', async () => {
  const f = await setup()
  const fetch = upstream(JSON.stringify({ choices: [], usage: { cost: 0.13 } })); vi.stubGlobal('fetch', fetch)
  expect((await f.send()).status).toBe(200)
  expect((await f.send({}, {}, crypto.randomUUID())).status).toBe(429)
  expect(completions(fetch)).toBe(1)
})
it('rejects projectless and unauthorized requests instead of billing org zero', async () => {
  const f = await setup(); const fetch = upstream('{}'); vi.stubGlobal('fetch', fetch)
  await env.AQUILLA_PG.exec("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Other', 2); INSERT INTO projects (id, name, org_id, created_by) VALUES ('other', 'Other', 2, 2)")
  expect((await f.send({ projectId: undefined })).status).toBe(403)
  expect((await f.send({ projectId: 'other' })).status).toBe(403)
  expect((await f.send({ projectId: 'unknown' })).status).toBe(403)
  expect(completions(fetch)).toBe(0)
})
it('fails closed when rehearsal targets a real provider or deployed worker', async () => {
  const f = await setup(); const fetch = upstream('{}'); vi.stubGlobal('fetch', fetch)
  expect((await f.send({}, { OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' })).status).toBe(503)
  expect((await f.send({}, { WRANGLER_LOCAL: undefined })).status).toBe(503)
  expect(completions(fetch)).toBe(0)
})
it('retains the reservation after provider failure', async () => {
  const f = await setup(); vi.stubGlobal('fetch', withRateCard(vi.fn(async () => { throw new Error('Connection lost') })))
  expect((await f.send()).status).toBe(500)
  expect((await f.totals()).reserved).toBe(1_562_500)
})

it('settles before delivering DONE when the client stops without draining transport EOF', async () => {
  const f = await setup()
  let sent = false
  vi.stubGlobal('fetch', withRateCard(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('data: {"usage":{"cost":0.001}}\n\ndata: [DONE]\n\n')) }
      // Keep the transport open: the client considers DONE the completion boundary.
    },
  })))))
  const response = await f.send({ stream: true }); const reader = response.body!.getReader()
  const chunk = await reader.read()
  expect(new TextDecoder().decode(chunk.value)).toContain('[DONE]')
  expect((await f.totals()).settled).toBe(400_000)
  await reader.cancel()
  expect((await f.totals()).reserved).toBe(0)
})

it('enforce mode meters a live provider URL and retires the legacy ledgers for the call', async () => {
  const f = await setup()
  vi.stubGlobal('fetch', upstream(JSON.stringify({ choices: [], usage: { cost: 0.001 } })))
  const enforce = { BILLING_CHAT_USAGE_REHEARSAL: undefined, BILLING_WEEKLY_USAGE_ENFORCE: 'true', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' }
  const response = await f.send({}, enforce)
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('settled')
  expect((await f.totals()).settled).toBe(400_000)
  const legacy = await env.AQUILLA_PG.prepare('SELECT (SELECT count(*) FROM org_credit_usage_daily) AS credits, (SELECT count(*) FROM org_word_usage_daily) AS words').first<{ credits: number; words: number }>()
  expect(legacy).toEqual({ credits: 0, words: 0 })
  // Off: the same request records only the legacy ledgers.
  expect((await f.send({}, { BILLING_CHAT_USAGE_REHEARSAL: undefined }, crypto.randomUUID())).status).toBe(200)
  expect((await f.totals()).settled).toBe(400_000)
  expect((await env.AQUILLA_PG.prepare('SELECT count(*) AS n FROM org_credit_usage_daily').first<{ n: number }>())?.n).toBe(1)
})
