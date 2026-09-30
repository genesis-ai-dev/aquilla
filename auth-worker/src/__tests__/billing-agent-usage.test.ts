import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { completedPayment, config } from './helpers/workspace-billing'
import { authHeader, jwtFor } from './helpers/db'
import { listHeldUsage, readUsageTotals } from '../lib/billing/workspace-usage'
import { readBillingWorkspace } from '../lib/billing/workspace'
import { resetRateCardCache } from '../lib/billing/rate-card'
import { rateCard } from './helpers/rate-card'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const FILE = '22222222-2222-4222-8222-222222222222'
afterEach(() => { vi.unstubAllGlobals(); resetRateCardCache() })

interface Frame { type: string; [key: string]: unknown }
const frames = (sse: string) => sse.split('\n\n').filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)) as Frame)
const turn = (message: Record<string, unknown>, extra: Record<string, unknown> = { id: 'gen', usage: { cost: 0.001 } }) =>
  new Response(JSON.stringify({ choices: [{ message }], ...extra }), { headers: { 'Content-Type': 'application/json' } })
const prose = (text: string, extra?: Record<string, unknown>) => turn({ role: 'assistant', content: text }, extra)

async function setup() {
  const paid = await completedPayment('pro', 'month')
  expect((await paid.send()).status).toBe(200)
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Agent', 1, 1)").bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(`INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
    VALUES (?, ?, '33333333-3333-4333-8333-333333333333', 'source', 'In the beginning', 'GEN 1:1', '44444444-4444-4444-8444-444444444444', 0),
           (?, ?, '33333333-3333-4333-8333-333333333333', 'target', '', 'GEN 1:1', '55555555-5555-4555-8555-555555555555', 0)`)
    .bind(PROJECT, FILE, PROJECT, FILE).run()
  const settings: Env = { ...config(), OPENROUTER_API_KEY: 'local-fixture', OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1',
    AI_ALLOWED_MODELS: 'local-test', AGENT_MODEL_DEFAULT: 'local-test', AGENT_DRAFT_MODEL_DEFAULT: 'local-test',
    BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  const run = async (overrides: Partial<Env> = {}, projectId = PROJECT) => {
    const response = await app.request('http://127.0.0.1/api/v1/ai/agent/run', { method: 'POST', headers: authHeader(await jwtFor('alice')),
      body: JSON.stringify({ projectId, messages: [{ role: 'user', content: 'Draft the empty verses' }], context: { fileId: FILE } }),
    }, { ...settings, ...overrides })
    return { status: response.status, frames: response.status === 200 ? frames(await response.text()) : [] }
  }
  const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  const totals = () => readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
  return { run, totals }
}
/** Scripted provider: `/models` serves the card; completions pop the script. */
function provider(script: Array<Response | (() => Response)>) {
  const completions: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/models')) return rateCard()
    completions.push(JSON.parse(String(init?.body)))
    const next = script.shift()
    if (!next) throw new Error('script exhausted')
    return typeof next === 'function' ? next() : next
  }))
  return completions
}

it('reserves and settles every orchestrator turn from real handler output', async () => {
  const f = await setup()
  const completions = provider([prose('Nothing to do.', { id: 'gen-1', usage: { cost: 0.001 } })])
  const { status, frames } = await f.run()
  expect(status).toBe(200)
  expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'ok' })
  expect((completions[0] as { max_tokens: number }).max_tokens).toBe(4096)
  expect(await f.totals()).toEqual({ reserved: 0, settled: 400_000, committed: 400_000 })
  const rows = await env.AQUILLA_PG.prepare("SELECT rail, provider_ref, state FROM workspace_usage_requests WHERE org_id = 1").all<{ rail: string; provider_ref: string; state: string }>()
  expect(rows.results).toEqual([{ rail: 'agent', provider_ref: 'gen-1', state: 'settled' }])
})
it('meters nested drafting passes as their own steps', async () => {
  const f = await setup()
  const completions = provider([
    turn({ role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'draft', arguments: JSON.stringify({ fileId: FILE }) } }] }, { id: 'o1', usage: { cost: 0.001 } }),
    prose('evidence: Genesis opening', { id: 'r1', usage: { cost: 0.002 } }),
    prose('[{"i":1,"t":"Au commencement"}]', { id: 'g1', usage: { cost: 0.003 } }),
    prose('Staged one draft.', { id: 'o2', usage: { cost: 0.001 } }),
  ])
  const { frames } = await f.run()
  expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'ok' })
  expect(completions).toHaveLength(4)
  expect((completions[1] as { max_tokens: number }).max_tokens).toBe(4096)
  expect(await f.totals()).toEqual({ reserved: 0, settled: 2_800_000, committed: 2_800_000 })
  const refs = await env.AQUILLA_PG.prepare("SELECT provider_ref FROM workspace_usage_requests WHERE org_id = 1 ORDER BY created_at").all<{ provider_ref: string }>()
  expect(refs.results.map(r => r.provider_ref)).toEqual(['o1', 'r1', 'g1', 'o2'])
})
it('stops the next step once the week is spent and never calls the provider for it', async () => {
  const f = await setup()
  // 13 raw cents = 52 units on a 50-unit week: the run completes, the week is over.
  provider([prose('Expensive answer', { id: 'big', usage: { cost: 0.13 } })])
  expect((await f.run()).frames.at(-1)).toMatchObject({ type: 'done', status: 'ok' })
  const completions = provider([prose('never')])
  const { frames } = await f.run()
  expect(frames).toContainEqual(expect.objectContaining({ type: 'budget.exhausted', reason: 'weekly_allowance' }))
  expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'capped' })
  expect(completions).toHaveLength(0)
  expect((await f.totals()).committed).toBe(52_000_000)
})
it('refuses a drafting pass mid-run without losing the orchestrator turn already settled', async () => {
  const f = await setup()
  const completions = provider([
    turn({ role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'draft', arguments: JSON.stringify({ fileId: FILE }) } }] }, { id: 'o1', usage: { cost: 0.125 } }),
    prose('after refusal', { id: 'o2', usage: { cost: 0.001 } }),
  ])
  const { frames } = await f.run()
  // The orchestrator turn settled at exactly 100%; the research pass may not start.
  expect(frames).toContainEqual(expect.objectContaining({ type: 'budget.exhausted', reason: 'weekly_allowance' }))
  expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'capped' })
  expect(completions).toHaveLength(1)
  expect(await f.totals()).toEqual({ reserved: 0, settled: 50_000_000, committed: 50_000_000 })
})
it('holds uncertain steps for reconciliation and fails closed on unpriced models and unowned projects', async () => {
  const f = await setup()
  provider([prose('no cost reported', { id: 'gen-held' })])
  expect((await f.run()).frames.at(-1)).toMatchObject({ type: 'done', status: 'ok' })
  provider([() => new Response('overloaded', { status: 503 })])
  expect((await f.run()).frames.at(-1)).toMatchObject({ type: 'done', status: 'error' })
  const held = await listHeldUsage(env.AQUILLA_PG, 1)
  expect(held.map(h => h.provider_ref)).toEqual(['gen-held', null])
  const completions = provider([prose('never')])
  expect((await f.run({ AGENT_MODEL_DEFAULT: 'unknown-model', AI_ALLOWED_MODELS: 'unknown-model' })).frames)
    .toContainEqual(expect.objectContaining({ type: 'error', message: 'model_price_unavailable' }))
  expect((await f.run({ OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' })).status).toBe(503)
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('unowned', 'Unowned', 1)").run()
  expect((await f.run({}, 'unowned')).status).toBe(403)
  expect(completions).toHaveLength(0)
})
