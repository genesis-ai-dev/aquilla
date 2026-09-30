import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import { authHeader, jwtFor } from './helpers/db'
import { completedPayment, config } from './helpers/workspace-billing'
import { readBillingWorkspace } from '../lib/billing/workspace'
import { readUsageTotals, reserveWorkspaceUsage, settleWorkspaceUsage } from '../lib/billing/workspace-usage'
import { resetTranscriptionRateCache } from '../lib/billing/transcription-usage'

const projectId = 'transcription-usage-project'
afterEach(() => { vi.unstubAllGlobals(); resetTranscriptionRateCache() })
async function fixture() {
  const paid = await completedPayment('pro', 'month')
  expect((await paid.send()).status).toBe(200)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Audio', 1, 1)",
  ).bind(projectId).run()
  const provider = vi.fn(async () => Response.json({ text: 'hello',
    words: [{ word: 'hello', start: 0, end: 0.5 }], usage: { seconds: 1, cost: 0.0001 },
  }, { headers: { 'X-Generation-Id': 'gen-whisper' } }))
  vi.stubGlobal('fetch', vi.fn(async input => {
    if (String(input).includes('/models?')) return Response.json({ data: [
      { id: 'openai/whisper-1', pricing: { prompt: '0.0001' } },
    ] })
    if (String(input).endsWith('/audio/transcriptions')) return provider()
    throw new Error(`unexpected provider ${input}`)
  }))
  const producerPath = new URL('../../../src/lib/audio/transcription-request.ts', import.meta.url).pathname
  const { buildTranscriptionRequest } = await import(producerPath)
  const body = await buildTranscriptionRequest(new Float32Array(16000), projectId)
  const settings = { ...config(), OPENROUTER_API_KEY: 'platform',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1', BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  const send = async (key = crypto.randomUUID(), payload = body, overrides = {}) =>
    app.request('http://127.0.0.1/api/v1/audio/transcriptions', {
      method: 'POST', headers: { ...authHeader(await jwtFor('alice')),
        'Idempotency-Key': key }, body: JSON.stringify(payload),
    }, { ...settings, ...overrides })
  const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  const period = { start: plan.usagePeriodStart, end: plan.usagePeriodEnd }
  return { send, body, provider, period, buildTranscriptionRequest,
    totals: () => readUsageTotals(env.AQUILLA_PG, 1, period) }
}
it('meters real client WAV output through auth and settles provider cost to capacity', async () => {
  const f = await fixture()
  const response = await f.send()
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('settled')
  expect(await f.totals()).toEqual({ reserved: 0, settled: 40000, committed: 40000 })
  const capacity = await app.request('/api/v2/orgs/1/billing/workspace', {
    headers: authHeader(await jwtFor('alice')),
  }, config())
  expect(capacity.status).toBe(200)
  expect(await capacity.json()).toMatchObject({ usagePercent: 0,
    usageResetsAt: f.period.end })
  expect(await env.AQUILLA_PG.prepare(
    'SELECT org_id, project_id, user_id, provider_ref FROM workspace_usage_requests',
  ).first()).toEqual({ org_id: 1, project_id: projectId, user_id: 1, provider_ref: 'gen-whisper' })
  expect(await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_credit_usage_daily')
    .first()).toEqual({ n: 0 })
})
it('refuses exhausted weekly capacity before invoking Whisper', async () => {
  const f = await fixture()
  await reserveWorkspaceUsage(env.AQUILLA_PG, { orgId: 1, projectId, userId: 1,
    requestId: 'spent', rail: 'llm', maxRawCostCents: 12.5 })
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, 'spent', 12.5)
  const response = await f.send()
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({ error: 'weekly_ai_allowance_exhausted' })
  expect(f.provider).not.toHaveBeenCalled()
  const capacity = await app.request('/api/v2/orgs/1/billing/workspace', {
    headers: authHeader(await jwtFor('alice')),
  }, config())
  expect(capacity.status).toBe(200)
  expect(await capacity.json()).toMatchObject({ usagePercent: 100 })
})
it('holds unknown provider costs and records the generation header for reconciliation', async () => {
  const f = await fixture()
  f.provider.mockResolvedValue(Response.json({ text: 'hello',
    words: [{ word: 'hello', start: 0, end: 0.5 }],
  }, { headers: { 'X-Generation-Id': 'gen-unknown-cost' } }))
  const response = await f.send()
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Billing-Usage-Status')).toBe('pending')
  expect(await f.totals()).toEqual({ reserved: 40000, settled: 0, committed: 40000 })
  expect(await env.AQUILLA_PG.prepare('SELECT provider_ref FROM workspace_usage_requests')
    .first()).toEqual({ provider_ref: 'gen-unknown-cost' })
})
it('does not invoke Whisper twice for the same usage request', async () => {
  const f = await fixture()
  const key = crypto.randomUUID()
  expect((await f.send(key)).status).toBe(200)
  expect((await f.send(key)).status).toBe(409)
  expect(f.provider).toHaveBeenCalledOnce()
})
it('holds capacity after an uncertain provider failure', async () => {
  const f = await fixture()
  f.provider.mockRejectedValue(new Error('connection lost'))
  expect((await f.send()).status).toBe(502)
  expect(await f.totals()).toEqual({ reserved: 40000, settled: 0, committed: 40000 })
})
it('rejects forged and oversized audio before starting paid work', async () => {
  const f = await fixture()
  expect((await f.send(crypto.randomUUID(), { ...f.body,
    input_audio: { data: 'UklGRg==', format: 'wav' } })).status).toBe(400)
  expect((await f.send(crypto.randomUUID(), await f.buildTranscriptionRequest(
    new Float32Array(61 * 16000), projectId,
  ))).status).toBe(400)
  expect(f.provider).not.toHaveBeenCalled()
  expect((await f.totals()).committed).toBe(0)
})
it('uses the legacy credit ledger when weekly accounting is off', async () => {
  const f = await fixture()
  expect((await f.send(crypto.randomUUID(), f.body,
    { BILLING_CHAT_USAGE_REHEARSAL: undefined })).status).toBe(200)
  expect(await env.AQUILLA_PG.prepare(
    'SELECT org_id, user_id, rail, raw_cost_cents, units FROM org_credit_usage_daily',
  ).first()).toEqual({ org_id: 1, user_id: 1, rail: 'llm', raw_cost_cents: 0.01, units: 1 })
  expect((await f.totals()).committed).toBe(0)
})
it('enforces the existing legacy cap before invoking Whisper', async () => {
  const f = await fixture()
  await env.AQUILLA_PG.prepare(`INSERT INTO org_credit_usage_daily
    (org_id, user_id, date_utc, rail, raw_cost_cents, units)
    VALUES (1, 1, ?, 'llm', 1, 1)`)
    .bind(new Date().toISOString().slice(0, 10)).run()
  expect((await f.send(crypto.randomUUID(), f.body, {
    BILLING_CHAT_USAGE_REHEARSAL: undefined, CREDIT_ENFORCE: 'true', CREDIT_DAILY_CAP: '1',
  })).status).toBe(429)
  expect(f.provider).not.toHaveBeenCalled()
})

it('refuses missing catalog prices before paid work', async () => {
  const f = await fixture()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })))
  expect((await f.send()).status).toBe(503)
  expect(f.provider).not.toHaveBeenCalled()
  expect((await f.totals()).committed).toBe(0)
})
it('records billed malformed output before reporting a transcript error', async () => {
  const f = await fixture()
  f.provider.mockResolvedValue(Response.json({ text: 'no timings',
    usage: { cost: 0.0001 },
  }, { headers: { 'X-Generation-Id': 'gen-malformed' } }))
  expect((await f.send()).status).toBe(502)
  expect(await f.totals()).toEqual({ reserved: 0, settled: 40000, committed: 40000 })
})
it('retains the provider reference on an upstream failure for reconciliation', async () => {
  const f = await fixture()
  f.provider.mockResolvedValue(new Response('provider error', { status: 502,
    headers: { 'X-Generation-Id': 'gen-failed' } }))
  expect((await f.send()).status).toBe(502)
  expect(await env.AQUILLA_PG.prepare('SELECT state, provider_ref FROM workspace_usage_requests')
    .first()).toEqual({ state: 'reserved', provider_ref: 'gen-failed' })
})
