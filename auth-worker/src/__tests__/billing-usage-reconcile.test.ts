import { env } from 'cloudflare:test'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { completedPayment, config } from './helpers/workspace-billing'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { readUsageRequest, readUsageTotals, settleWorkspaceUsage } from '../lib/billing/workspace-usage'
import { readBillingWorkspace } from '../lib/billing/workspace'

afterEach(() => vi.unstubAllGlobals())
async function setup() {
  const paid = await completedPayment('pro', 'month')
  expect((await paid.send()).status).toBe(200)
  await env.AQUILLA_PG.exec("INSERT INTO projects (id, name, org_id, created_by) VALUES ('chat-project', 'Chat', 1, 1)")
  const settings: Env = { ...config(), OPENROUTER_API_KEY: 'local-fixture', AI_ALLOWED_MODELS: 'local-test',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1', BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  const chat = async (id: string, extra: Record<string, unknown> = {}) => app.request(
    'http://127.0.0.1/api/v1/chat/completions', { method: 'POST',
      headers: { ...authHeader(await jwtFor('alice')), 'Idempotency-Key': id },
      body: JSON.stringify({ model: 'local-test', projectId: 'chat-project', messages: [{ role: 'user', content: 'Hi' }], ...extra }),
    }, settings)
  const reconcile = async (requestId: string, overrides: Partial<Env> = {}, username = 'alice') => app.request(
    'http://127.0.0.1/api/v2/orgs/1/billing/usage-rehearsal/reconcile', { method: 'POST',
      headers: authHeader(await jwtFor(username)), body: JSON.stringify({ requestId }) }, { ...settings, ...overrides })
  const held = async () => (await (await app.request('http://127.0.0.1/api/v2/orgs/1/billing/usage-rehearsal/held',
    { headers: authHeader(await jwtFor('alice')) }, settings)).json()) as { held: Array<{ requestId: string; referenced: boolean }> }
  const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  const totals = () => readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
  const request = (id: string) => readUsageRequest(env.AQUILLA_PG, 1, id)
  return { chat, reconcile, held, totals, request }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
/** Scripted provider: chat completion first, then generation lookups by id. */
function provider(completion: Response | (() => Response), generation: (id: string) => Response) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input); calls.push(url)
    if (url.includes('/generation')) return generation(new URL(url).searchParams.get('id') ?? '')
    return typeof completion === 'function' ? completion() : completion.clone()
  }))
  return calls
}

it('reconciles a held JSON request from the provider generation record exactly once', async () => {
  const f = await setup(); const id = crypto.randomUUID()
  const calls = provider(json({ id: 'gen-1', choices: [{ message: { content: 'Answer' } }] }),
    ref => json({ data: { id: ref, total_cost: 0.0025 } }))
  expect((await f.chat(id)).headers.get('X-Billing-Usage-Status')).toBe('pending')
  expect((await f.request(id))!.provider_ref).toBe('gen-1')
  expect(await f.held()).toEqual({ held: [expect.objectContaining({ requestId: id, referenced: true })] })
  expect(await (await f.reconcile(id)).json()).toEqual({ status: 'settled' })
  expect(calls.filter(u => u.includes('/generation?id=gen-1'))).toHaveLength(1)
  expect(await f.totals()).toEqual({ reserved: 0, settled: 1_000_000, committed: 1_000_000 })
  expect(await (await f.reconcile(id)).json()).toEqual({ status: 'already_settled' })
  expect(calls.filter(u => u.includes('/generation'))).toHaveLength(1)
  expect((await f.held()).held).toEqual([])
})
it('records the stream generation id on truncation and reconciles it later', async () => {
  const f = await setup(); const id = crypto.randomUUID()
  provider(() => new Response('data: {"id":"gen-stream","choices":[]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    ref => json({ data: { id: ref, total_cost: 0.001 } }))
  const response = await f.chat(id, { stream: true })
  await response.text()
  expect((await f.request(id))!.provider_ref).toBe('gen-stream')
  expect((await f.totals()).reserved).toBe(4_000_000)
  expect(await (await f.reconcile(id)).json()).toEqual({ status: 'settled' })
  expect(await f.totals()).toEqual({ reserved: 0, settled: 400_000, committed: 400_000 })
})
it('keeps unreferenced, unavailable, and mismatched records held without contacting the provider blindly', async () => {
  const f = await setup(); const unreferenced = crypto.randomUUID(); const referenced = crypto.randomUUID()
  const calls = provider(json({ choices: [{ message: { content: 'No id' } }] }), () => json({ error: 'down' }, 503))
  expect((await f.chat(unreferenced)).headers.get('X-Billing-Usage-Status')).toBe('pending')
  expect(await (await f.reconcile(unreferenced)).json()).toEqual({ status: 'unreferenced' })
  expect(calls.filter(u => u.includes('/generation'))).toHaveLength(0)
  vi.unstubAllGlobals()
  let record: unknown = { error: 'down' }
  provider(json({ id: 'gen-2', choices: [{ message: { content: 'No cost' } }] }), () => json(record))
  expect((await f.chat(referenced)).headers.get('X-Billing-Usage-Status')).toBe('pending')
  expect(await (await f.reconcile(referenced)).json()).toEqual({ status: 'unavailable' })
  record = { data: { id: 'gen-other', total_cost: 0.001 } }
  expect(await (await f.reconcile(referenced)).json()).toEqual({ status: 'unavailable' })
  record = { data: { id: 'gen-2', total_cost: 'free' } }
  expect(await (await f.reconcile(referenced)).json()).toEqual({ status: 'unavailable' })
  expect(await f.totals()).toEqual({ reserved: 8_000_000, settled: 0, committed: 8_000_000 })
  record = { data: { id: 'gen-2', total_cost: 0.001 } }
  expect(await (await f.reconcile(referenced)).json()).toEqual({ status: 'settled' })
  expect(await f.totals()).toEqual({ reserved: 4_000_000, settled: 400_000, committed: 4_400_000 })
})
it('rejects a conflicting provider reference instead of rebinding the request', async () => {
  const f = await setup(); const id = crypto.randomUUID()
  provider(json({ id: 'gen-a', choices: [] }), () => json({}))
  expect((await f.chat(id)).headers.get('X-Billing-Usage-Status')).toBe('pending')
  await expect(settleWorkspaceUsage(env.AQUILLA_PG, 1, id, 1, 'gen-b')).rejects.toThrow('provider reference conflict')
  expect((await f.request(id))!.state).toBe('reserved')
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, id, 1, 'gen-a')
  expect((await f.request(id))!.state).toBe('settled')
})
it('gates reconciliation to local rehearsal, maintainers, and known requests', async () => {
  const f = await setup(); const id = crypto.randomUUID()
  provider(json({ id: 'gen-1', choices: [] }), () => json({}))
  await f.chat(id)
  await seedUser(9, 'outsider')
  expect((await f.reconcile(id, {}, 'outsider')).status).toBe(403)
  expect((await f.reconcile(id, { BILLING_CHAT_USAGE_REHEARSAL: 'false' })).status).toBe(503)
  expect((await f.reconcile(id, { OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' })).status).toBe(503)
  expect((await f.reconcile(crypto.randomUUID())).status).toBe(404)
  expect((await f.reconcile('not-a-uuid')).status).toBe(400)
  expect((await f.totals()).reserved).toBe(4_000_000)
})
it('replays the provider reference migration without losing held usage', async () => {
  const f = await setup(); const id = crypto.randomUUID()
  provider(json({ id: 'gen-1', choices: [] }), () => json({}))
  await f.chat(id)
  const migration = readFileSync(new URL('../../../db/postgres/migrations/0098_workspace_usage_provider_ref.sql', import.meta.url), 'utf8')
  await env.AQUILLA_PG.exec(migration)
  await env.AQUILLA_PG.exec(migration)
  expect((await f.request(id))!.provider_ref).toBe('gen-1')
  await expect(env.AQUILLA_PG.exec("UPDATE workspace_usage_requests SET provider_ref = ''")).rejects.toThrow()
  expect((await f.totals()).reserved).toBe(4_000_000)
})
