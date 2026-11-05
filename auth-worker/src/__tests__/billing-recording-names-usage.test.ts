// AQU-2302: the naming-rule call is billed like the importer's classifier:
// charged once per request, and a rejection that proves no model ran is
// released rather than held against the workspace.
import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { completedPayment, config, pinSmallAllowancePolicy } from './helpers/workspace-billing'
import { authHeader, jwtFor } from './helpers/db'
import { readUsageTotals } from '../lib/billing/workspace-usage'
import { readBillingWorkspace } from '../lib/billing/workspace'
import { resetRateCardCache } from '../lib/billing/rate-card'
import { withRateCard } from './helpers/rate-card'

afterEach(() => { vi.unstubAllGlobals(); resetRateCardCache() })
const rule = { templates: [{ pattern: '{book}-ch{chapter}_v{verse}' }], books: { Mt: 'MAT' }, explanation: 'Mt is Matthew.' }
async function setup() {
  const paid = await completedPayment('team', 'month', undefined, 'personal')
  expect((await paid.send()).status).toBe(200)
  await pinSmallAllowancePolicy()
  await env.AQUILLA_PG.exec("INSERT INTO projects (id, name, org_id, created_by) VALUES ('names-project', 'Names', 1, 1)")
  const settings: Env = { ...config(), OPENROUTER_API_KEY: 'local-fixture', AI_BUDGET_ENFORCE: 'false', DEFAULT_LLM_MODEL: 'local-test', AI_ALLOWED_MODELS: 'local-test',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1', BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  const key = crypto.randomUUID()
  const send = async (id = key) => app.request(
    'http://127.0.0.1/api/v1/import/recording-names', { method: 'POST',
      headers: { ...authHeader(await jwtFor('alice')), 'Idempotency-Key': id },
      body: JSON.stringify({ projectId: 'names-project', names: ['Mt-ch19_v01.ogg'], outline: 'MAT (Matthew): verses per chapter 25,23' }),
    }, settings)
  const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  const totals = () => readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
  return { send, totals }
}
const completions = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => String(url).includes('/chat/completions')).length
function upstream(body: unknown, status = 200) {
  return withRateCard(vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))
}
it('charges a naming-rule call once, and refuses to run the same request twice', async () => {
  const f = await setup()
  const fetch = upstream({ choices: [{ message: { content: JSON.stringify(rule) } }], usage: { cost: 0.00125 } })
  vi.stubGlobal('fetch', fetch)
  const response = await f.send()
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('settled')
  expect(await f.totals()).toEqual({ reserved: 0, settled: 500_000, committed: 500_000 })
  expect((await f.send()).status).toBe(409)
  expect(completions(fetch)).toBe(1)
  expect((await f.totals()).committed).toBe(500_000)
})
it('releases the reservation when the provider refuses before any model ran', async () => {
  const f = await setup()
  vi.stubGlobal('fetch', upstream({ error: { message: 'bad request' } }, 400))
  const response = await f.send()
  expect(response.status).toBe(502)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('released')
  expect(await f.totals()).toEqual({ reserved: 0, settled: 0, committed: 0 })
})
