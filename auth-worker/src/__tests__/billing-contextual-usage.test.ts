import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { completedPayment, config } from './helpers/workspace-billing'
import { authHeader, jwtFor } from './helpers/db'
import { readUsageTotals, reserveWorkspaceUsage, settleWorkspaceUsage } from '../lib/billing/workspace-usage'
import { readBillingWorkspace } from '../lib/billing/workspace'
import { resetRateCardCache } from '../lib/billing/rate-card'
import { rateCard } from './helpers/rate-card'
import { _test } from '../routes/contextual'
import { getRun } from '../../../db/shared/contextual-runs'
import { scriptMockResponse } from '../../../scripts/mock-openrouter'

const PROJECT = 'proj-ctx-usage'
const FILE = 'file-mrk'
afterEach(async () => { if (_test.lastLoop) await _test.lastLoop; _test.lastLoop = null; vi.unstubAllGlobals(); resetRateCardCache() })

async function setup() {
  const paid = await completedPayment('pro', 'month')
  expect((await paid.send()).status).toBe(200)
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Autopilot', 1, 1)").bind(PROJECT).run()
  // The start gate (AQU-827) needs both languages and an answered brief question.
  await env.AQUILLA_PG.prepare('INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)')
    .bind(PROJECT, JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'sw', translationBrief: { parameters: { purpose: 'Community reading' } } })).run()
  for (const [cellId, ref, text] of [['c1', 'MRK 1:1', 'In the beginning'], ['c2', 'MRK 1:2', 'was the word']] as const) {
    await env.AQUILLA_PG.prepare(`INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
      VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`).bind(PROJECT, FILE, cellId, text, ref, `ev-${cellId}`).run()
  }
  const settings: Env = { ...config(), OPENROUTER_API_KEY: 'local-fixture', OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1',
    AI_ALLOWED_MODELS: 'local-test', AGENT_MODEL_DEFAULT: 'local-test', CONTEXTUAL_FAST_MODEL: 'local-test',
    CONTEXTUAL_DEEP_MODEL: 'local-test', BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  const completions: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/models')) return rateCard()
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      completions.push(body.messages[1]?.content.slice(0, 40) ?? '')
      return new Response(JSON.stringify(scriptMockResponse(body.messages)), { headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/admin/projects/')) return new Response('{}')
    throw new Error(`unexpected fetch ${url}`)
  }))
  const start = async (overrides: Partial<Env> = {}, projectId = PROJECT) => {
    const response = await app.request(`http://127.0.0.1/api/v2/projects/${projectId}/contextual/runs`, { method: 'POST',
      headers: authHeader(await jwtFor('alice')), body: JSON.stringify({ fileId: FILE }) }, { ...settings, ...overrides })
    const runId = response.status === 201 ? ((await response.json()) as { runId: string }).runId : undefined
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null
    return { status: response.status, runId }
  }
  const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  const totals = () => readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
  return { start, totals, completions }
}

it('reserves and settles every autopilot graph call through the run owner workspace', async () => {
  const f = await setup()
  const { status, runId } = await f.start()
  expect(status).toBe(201)
  expect((await getRun(env.AQUILLA_PG, runId!))?.status).toBe('parked')
  expect(f.completions.length).toBeGreaterThan(0)
  // Each scripted call reports 0.0004 USD = 40,000 micro-cents = 160,000 units.
  expect(await f.totals()).toEqual({ reserved: 0, settled: f.completions.length * 160_000, committed: f.completions.length * 160_000 })
  const rows = await env.AQUILLA_PG.prepare("SELECT rail, provider_ref, user_id FROM workspace_usage_requests WHERE org_id = 1")
    .all<{ rail: string; provider_ref: string; user_id: number }>()
  expect(rows.results).toHaveLength(f.completions.length)
  expect(rows.results.every(r => r.rail === 'agent' && r.user_id === 1 && r.provider_ref?.startsWith('mock-'))).toBe(true)
})
it('pauses a run at the span edge once the week is spent, without calling the provider', async () => {
  const f = await setup()
  const period = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
  await reserveWorkspaceUsage(env.AQUILLA_PG, { orgId: 1, projectId: PROJECT, userId: 1, requestId: 'spent', rail: 'agent', maxRawCostCents: 12.5 },
    new Date(Date.parse(period.usagePeriodStart) + 1000))
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, 'spent', 12.5)
  const { status, runId } = await f.start()
  expect(status).toBe(201)
  const run = await getRun(env.AQUILLA_PG, runId!)
  expect(run?.status).toBe('paused')
  expect(f.completions).toHaveLength(0)
  expect((await f.totals()).committed).toBe(50_000_000)
})
it('fails closed on unowned projects and non-local providers before creating a run', async () => {
  const f = await setup()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('unowned', 'Unowned', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings, version, updated_by) SELECT 'unowned', settings, 1, 1 FROM project_settings WHERE project_id = ?").bind(PROJECT).run()
  expect((await f.start({}, 'unowned')).status).toBe(403)
  expect((await f.start({ OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' })).status).toBe(503)
  expect(f.completions).toHaveLength(0)
})
