// AQU-2064 (unified billing T7): every Jev call on the `jev` rail.
//
// Why these matter. Jev was the one family of paid calls no ledger saw
// (spec §3.2 #17-22): a user could loop seams or passage tags and nothing
// recorded it. Now each call passes the one entitlement check and writes one
// jev row. Jev is priced at 0 for now (decision 2026-10-21), so a row costs
// nothing against the allowance, but it is still gated (ceiling, allowance,
// billing workspace) and still counted, so the price can be switched on in
// rate-card.ts without touching a route. The cron sweep and background runs
// have no live user and bill as the system (user_id NULL, spec §3.3).
import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { callJev } from '../lib/jev/client'
import { decide } from '../lib/jev/decide'
import { makeBibleTickDeps } from '../lib/contextual/bible-deps'
import { readUsageTotals } from '../lib/billing/workspace-usage'
import { resolveOrgPlan } from '../../../db/shared/org-plan'

const PROJECT = 'jev-project'
afterEach(() => vi.unstubAllGlobals())

async function freeOrg(project = PROJECT, orgId: number | null = 1) {
  await seedUser(1, 'alice')
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Free org', 1) ON CONFLICT DO NOTHING").run()
  await env.AQUILLA_PG.prepare('INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, ?, 1)').bind(project, 'Jev', orgId).run()
  return authHeader(await jwtFor('alice'))
}

function settings(mode: 'shadow' | 'off' = 'shadow'): Env {
  return Object.assign(Object.create(env) as Env, {
    ...(mode === 'shadow' ? { BILLING_METER_MODE: 'shadow' } : {}),
    OPENROUTER_API_KEY: 'house-key', OPENROUTER_BASE_URL: 'https://upstream.example/api/v1',
  })
}

/** Jev's decisions endpoint; `usage` is the tokens it reports. */
function jev(usage: Record<string, number> | null = { input_tokens: 120, output_tokens: 8 }) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.endsWith('/alpha/decisions')) throw new Error(`unexpected fetch ${url}`)
    calls.push(new Headers(init?.headers).get('Authorization') ?? '')
    return Response.json({ model: 'jev-1.13.0', answers: {}, ...(usage ? { usage } : {}) })
  }))
  return calls
}

async function jevRows() {
  return (await env.AQUILLA_PG.prepare(
    'SELECT rail, mode, decision, user_id, state, raw_micro_cents FROM workspace_usage_requests ORDER BY created_at',
  ).all<{ rail: string; mode: string; decision: string; user_id: number | null; state: string; raw_micro_cents: number | null }>()).results
}

/** One settled jev row per call, at 0, billed to `userId`, and nothing spent. */
async function expectOneFreeJevRowPerCall(calls: string[], userId: number | null) {
  const rows = await jevRows()
  expect(calls.length).toBeGreaterThan(0)
  expect(rows).toHaveLength(calls.length)
  expect(rows.every(r => r.rail === 'jev' && r.mode === 'metered' && r.decision === 'allow'
    && r.state === 'settled' && Number(r.raw_micro_cents) === 0 && r.user_id === userId)).toBe(true)
  const plan = (await resolveOrgPlan(env.AQUILLA_PG, 1))!
  expect((await readUsageTotals(env.AQUILLA_PG, 1, plan.period)).committed).toBe(0)
  // The key the entitlement check chose reached Jev.
  expect(calls.every(k => k === 'Bearer house-key')).toBe(true)
}

it('#17 ai-seams writes one jev row per call', async () => {
  const headers = await freeOrg()
  const calls = jev()
  const response = await app.request('/api/v1/ai/seams/classify', { method: 'POST', headers, body: JSON.stringify({
    projectId: PROJECT, cells: [{ id: 'c1', text: 'And he said', ref: 'EX 5:1' }, { id: 'c2', text: 'to Simon.', ref: 'EX 5:2' }],
  }) }, settings())
  expect(response.status).toBe(200)
  await expectOneFreeJevRowPerCall(calls, 1)
})

it('#18 ai-passage-tags goes through callJev and writes one jev row', async () => {
  const headers = await freeOrg()
  const calls = jev()
  const response = await app.request('/api/v1/ai/passage-tags/classify', { method: 'POST', headers, body: JSON.stringify({
    projectId: PROJECT,
    nodes: [{ key: 'passage:LUK 5:27', label: 'LUK 5:27–32', text: 'He saw a tax collector named Levi.',
      startRef: 'LUK 5:27', endRef: 'LUK 5:32', participants: ['Jesus', 'Levi'], related: [] }],
  }) }, settings())
  expect(response.status).toBe(200)
  await expectOneFreeJevRowPerCall(calls, 1)
})

it('#19 decide() from the react sweep bills the project org as the system user', async () => {
  await freeOrg()
  const calls = jev()
  const out = await decide(settings(), { purpose: 'react', projectId: PROJECT, state: {},
    questions: { q: { type: 'noul', instructions: { ask: 'Worth a run?' } } }, fallback: () => ({ q: { kind: 'noul', p: 0 } }) })
  expect(out.reason).not.toBe('refused')
  await expectOneFreeJevRowPerCall(calls, null)
})

it('#20 bible-deps bills the person running a check', async () => {
  await freeOrg()
  const calls = jev()
  const deps = makeBibleTickDeps(settings(), env.AQUILLA_PG, { projectId: PROJECT, runId: 'bible-check:t', userId: 1 })
  await deps.judge!.decide({ state: {}, questions: { q: { type: 'noul', instructions: { ask: 'Fits?' } } }, fallback: () => ({ q: { kind: 'noul', p: 0 } }) })
  await expectOneFreeJevRowPerCall(calls, 1)
})

it('#21 #22 callJev (harmonizer, smart-edits verify) keeps a reply without tokens held, never settled at a guess', async () => {
  await freeOrg()
  jev(null)
  expect((await callJev(settings(), { model: 'x' }, 5000, { projectId: PROJECT, userId: 1 })).ok).toBe(true)
  expect((await jevRows()).map(r => r.state)).toEqual(['reserved'])
})

it('writes no row while the meter is off, and still answers', async () => {
  await freeOrg()
  const calls = jev()
  expect((await callJev(settings('off'), { model: 'x' }, 5000, { projectId: PROJECT, userId: 1 })).ok).toBe(true)
  expect(calls).toHaveLength(1)
  expect(await jevRows()).toHaveLength(0)
})

it('refuses a metered call on a project with no billing workspace before reaching Jev', async () => {
  await freeOrg('unowned', null)
  const calls = jev()
  expect(await callJev(settings(), { model: 'x' }, 5000, { projectId: 'unowned', userId: 1 }))
    .toEqual({ ok: false, reason: 'refused' })
  expect(calls).toHaveLength(0)
})
