import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { completedPayment, config } from './helpers/workspace-billing'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { readUsageTotals } from '../lib/billing/workspace-usage'
import { readBillingWorkspace } from '../lib/billing/workspace'

afterEach(() => vi.unstubAllGlobals())
const recipe = { category: 'scripture', confidence: 0.9, explanation: 'Pipe rows',
  recipe: { name: 'Rows', inputFormat: 'pipe', config: { recordMode: 'delimited', delimiter: 'pipe', sourceField: 'source' } } }
async function setup() {
  const paid = await completedPayment('pro', 'month')
  expect((await paid.send()).status).toBe(200)
  await env.AQUILLA_PG.exec("INSERT INTO projects (id, name, org_id, created_by) VALUES ('import-project', 'Import', 1, 1)")
  const settings: Env = { ...config(), OPENROUTER_API_KEY: 'local-fixture', AI_BUDGET_ENFORCE: 'false',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1', BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  const key = crypto.randomUUID()
  const send = async (extra: Record<string, unknown> = {}, overrides: Partial<Env> = {}, id = key, username = 'alice') => app.request(
    'http://127.0.0.1/api/v1/import/classify', { method: 'POST',
      headers: { ...authHeader(await jwtFor(username)), 'Idempotency-Key': id },
      body: JSON.stringify({ projectId: 'import-project', fileName: 'rows.txt', sample: 'kind|source\nverse|Text', ...extra }),
    }, { ...settings, ...overrides })
  const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  const totals = () => readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
  return { send, totals }
}
function upstream(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}
it('settles the classifier cost from real handler output and blocks duplicate execution', async () => {
  const f = await setup()
  const fetch = upstream({ choices: [{ message: { content: JSON.stringify(recipe) } }], usage: { cost: 0.00125 } })
  vi.stubGlobal('fetch', fetch)
  const response = await f.send()
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('settled')
  expect(await f.totals()).toEqual({ reserved: 0, settled: 500_000, committed: 500_000 })
  expect((await f.send()).status).toBe(409)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('settles a charged malformed recipe instead of treating rejected output as free', async () => {
  const f = await setup()
  vi.stubGlobal('fetch', upstream({ choices: [{ message: { content: 'not json' } }], usage: { cost: 0.001 } }))
  const response = await f.send()
  expect(response.status).toBe(502)
  expect(await f.totals()).toEqual({ reserved: 0, settled: 400_000, committed: 400_000 })
})
it('keeps the reservation when the provider returns an error or omits cost', async () => {
  const f = await setup()
  vi.stubGlobal('fetch', upstream({ error: 'overloaded' }, 503))
  expect((await f.send()).status).toBe(502)
  expect((await f.totals()).reserved).toBe(4_000_000)
  vi.stubGlobal('fetch', upstream({ choices: [{ message: { content: JSON.stringify(recipe) } }] }))
  const response = await f.send({}, {}, crypto.randomUUID())
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('pending')
  expect((await f.totals()).reserved).toBe(8_000_000)
})
it('blocks exhausted allowance before starting the provider', async () => {
  const f = await setup()
  const fetch = upstream({ choices: [{ message: { content: JSON.stringify(recipe) } }], usage: { cost: 0.13 } })
  vi.stubGlobal('fetch', fetch)
  expect((await f.send()).status).toBe(200)
  expect((await f.send({}, {}, crypto.randomUUID())).status).toBe(429)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('rejects non-lead and unowned projects before reserving usage', async () => {
  const f = await setup(); const fetch = upstream({}); vi.stubGlobal('fetch', fetch)
  await seedUser(9, 'outsider')
  await env.AQUILLA_PG.exec("INSERT INTO projects (id, name, created_by) VALUES ('unowned', 'Unowned', 1)")
  expect((await f.send({}, {}, crypto.randomUUID(), 'outsider')).status).toBe(403)
  expect((await f.send({ projectId: 'unowned' }, {}, crypto.randomUUID())).status).toBe(403)
  expect((await f.send({}, { OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' })).status).toBe(503)
  expect(fetch).not.toHaveBeenCalled()
  expect((await f.totals()).committed).toBe(0)
})
