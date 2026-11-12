// AQU-2062 (unified billing T5): the already-metered paths in shadow mode.
//
// Why these matter. Shadow is how the meter ships to production (spec §5.4):
// every paid call writes its row and nothing is refused, so two weeks of rows
// can say who WOULD have been blocked before enforcement flips. That evidence
// is only true if each provider call writes exactly one row on one ledger:
//   - a missing row hides spend from the would-block report;
//   - a second row on the legacy credit ledger counts the call twice in the
//     platform spend ceiling, which sums both ledgers (ai-spend-ceiling.ts).
// And shadow must never refuse a customer for allowance: an over-limit call
// proceeds and is stored as `would_block`.
import { env } from 'cloudflare:test'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import app from '../index'
import type { Env } from '../types'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { rateCard } from './helpers/rate-card'
import { resetRateCardCache } from '../lib/billing/rate-card'
import { resetTranscriptionRateCache, WHISPER_MODEL } from '../lib/billing/transcription-usage'
import { reserveWorkspaceUsage } from '../lib/billing/workspace-usage'
import { resolveOrgPlan } from '../../../db/shared/org-plan'
import { _test, startReactionRun } from '../routes/contextual'
import { getRun } from '../../../db/shared/contextual-runs'
import { scriptMockResponse } from '../../../scripts/mock-openrouter'

const PROJECT = 'shadow-project'
const FILE = 'shadow-file'
const UPSTREAM = 'https://upstream.example/api/v1'
const MODAL = 'https://omni.example'

afterEach(async () => {
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  vi.unstubAllGlobals(); resetRateCardCache(); resetTranscriptionRateCache()
})

type Producer = (samples: Float32Array, projectId: string, language?: string) =>
  Promise<{ input_audio: { data: string; format: 'wav' } }>
let buildTranscriptionRequest: Producer
beforeAll(async () => {
  const producerPath = new URL('../../../src/lib/audio/transcription-request.ts', import.meta.url).pathname
  ;({ buildTranscriptionRequest } = await import(producerPath))
})

/** A Free org on the real default plan, one project with two source cells and
 *  the languages and brief autopilot needs. No Stripe: every org has a plan. */
async function freeOrg() {
  await seedUser(1, 'alice')
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Free org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Shadow', 1, 1)").bind(PROJECT).run()
  await env.AQUILLA_PG.prepare('INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)')
    .bind(PROJECT, JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'sw', autopilotEnabled: true,
      translationBrief: { parameters: { purpose: 'Community reading' } } })).run()
  await env.AQUILLA_PG.prepare(`INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
    VALUES ('sh-src', ?, 'source', 'English', NULL, 0), ('sh-tgt', ?, 'target', 'Swahili', '', 1)`).bind(PROJECT, PROJECT).run()
  for (const [cellId, ref, text] of [['c1', 'MRK 1:1', 'In the beginning'], ['c2', 'MRK 1:2', 'was the word']] as const) {
    await env.AQUILLA_PG.prepare(`INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
      VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`).bind(PROJECT, FILE, cellId, text, ref, `ev-${cellId}`).run()
  }
  expect((await resolveOrgPlan(env.AQUILLA_PG, 1))?.tier).toBe('free')
  return authHeader(await jwtFor('alice'))
}

/** Env for a mode. A run-scoped env inherits its secrets, so build it the
 *  same way: a spread would hide a key that only lives on the prototype. */
function settings(mode: 'shadow' | 'off', overrides: Partial<Env> = {}): Env {
  return Object.assign(Object.create(env) as Env, {
    ...(mode === 'shadow' ? { BILLING_METER_MODE: 'shadow' } : {}),
    OPENROUTER_API_KEY: 'house-key', OPENROUTER_BASE_URL: UPSTREAM,
    AI_ALLOWED_MODELS: 'local-test', DEFAULT_LLM_MODEL: 'local-test', AGENT_MODEL_DEFAULT: 'local-test',
    AGENT_DRAFT_MODEL_DEFAULT: 'local-test', CONTEXTUAL_FAST_MODEL: 'local-test', CONTEXTUAL_DEEP_MODEL: 'local-test',
    OMNI_ASR_MODAL_URL: `${MODAL}/`, OMNI_SHARED_SECRET: 'omni-secret',
    ...overrides,
  })
}

interface Calls { paid: number; keys: string[] }
/** Every provider: the OpenRouter card and chat/audio completions, and Modal. */
function providers(): Calls {
  const calls: Calls = { paid: 0, keys: [] }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/models')) return rateCard()
    if (url.includes('/models?')) return Response.json({ data: [{ id: WHISPER_MODEL, pricing: { prompt: '0.0001' } }] })
    if (url.includes('/admin/projects/')) return new Response('{}')
    const headers = new Headers(init?.headers)
    calls.keys.push(headers.get('Authorization') ?? headers.get('X-Omni-Secret') ?? '')
    calls.paid++
    if (url.endsWith('/audio/transcriptions')) {
      return Response.json({ text: 'hello', words: [{ word: 'hello', start: 0, end: 0.5 }], usage: { cost: 0.0001 } })
    }
    if (url === `${MODAL}/warm`) return Response.json({ ok: true })
    if (url === `${MODAL}/transcribe`) {
      return Response.json({ text: 'ami', words: [{ text: 'ami', start: 0, end: 0.4 }], gpuSeconds: 2, gpu: 'NVIDIA L4' })
    }
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[]; tools?: unknown }
      // Agent turns stream; everything else is one JSON completion.
      if (body.tools) {
        return new Response('data: {"id":"gen-agent","choices":[{"delta":{"content":"Done."}}]}\n\n'
          + 'data: {"id":"gen-agent","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001}}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (body.messages[0]?.content.includes('classify file structure')) {
        return Response.json({ id: 'gen-classify', usage: { cost: 0.001 }, choices: [{ message: { content: JSON.stringify({
          category: 'scripture', confidence: 0.9, explanation: 'Pipe rows',
          recipe: { name: 'Rows', inputFormat: 'pipe', config: { recordMode: 'delimited', delimiter: 'pipe', sourceField: 'source' } },
        }) } }] })
      }
      return Response.json(scriptMockResponse(body.messages))
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
  return calls
}

/** Rows on the one meter and on the two legacy ledgers it replaces. */
async function ledgers() {
  const meter = await env.AQUILLA_PG.prepare(
    'SELECT rail, mode, decision, user_id, state FROM workspace_usage_requests WHERE org_id = 1 ORDER BY created_at',
  ).all<{ rail: string; mode: string; decision: string; user_id: number | null; state: string }>()
  const credit = await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_credit_usage_daily').first<{ n: number }>()
  const words = await env.AQUILLA_PG.prepare('SELECT count(*)::int AS n FROM org_word_usage_daily').first<{ n: number }>()
  return { meter: meter.results, legacy: (credit?.n ?? 0) + (words?.n ?? 0) }
}

/** The shadow invariant: one settled meter row per provider call, on the
 *  path's rail, and nothing on the legacy ledgers. */
async function expectOneRowPerCall(calls: Calls, rail: string) {
  const { meter, legacy } = await ledgers()
  expect(calls.paid).toBeGreaterThan(0)
  expect(meter).toHaveLength(calls.paid)
  expect(meter.every(r => r.rail === rail && r.mode === 'metered' && r.decision === 'allow' && r.state === 'settled')).toBe(true)
  expect(legacy).toBe(0)
  // The key the entitlement check chose reached the provider.
  expect(calls.keys.every(k => k.includes('house-key') || k === 'omni-secret')).toBe(true)
}

const chat = (headers: Record<string, string>, env: Env) => app.request(`http://127.0.0.1/api/v1/chat/completions`, {
  method: 'POST', headers, body: JSON.stringify({ model: 'local-test', projectId: PROJECT, messages: [{ role: 'user', content: 'Hello' }] }),
}, env)

it('#1 chat: one meter row in shadow, and only the legacy ledger when the meter is off', async () => {
  const headers = await freeOrg()
  const calls = providers()
  expect((await chat(headers, settings('shadow'))).status).toBe(200)
  await expectOneRowPerCall(calls, 'llm')
  // Off: the meter writes nothing and the legacy ledgers stay the one record.
  expect((await chat(headers, settings('off'))).status).toBe(200)
  const { meter, legacy } = await ledgers()
  expect(meter).toHaveLength(1)
  expect(legacy).toBeGreaterThan(0)
})

it('shadow never refuses an over-limit call: it runs and is stored as would_block', async () => {
  const headers = await freeOrg()
  const plan = (await resolveOrgPlan(env.AQUILLA_PG, 1))!
  // Spend the whole Free week ($1 raw) first.
  await reserveWorkspaceUsage(env.AQUILLA_PG, { orgId: 1, projectId: PROJECT, userId: 1, requestId: 'spent', rail: 'llm',
    maxRawCostCents: 100 }, new Date(Date.parse(plan.period.start) + 1000))
  const calls = providers()
  expect((await chat(headers, settings('shadow'))).status).toBe(200)
  expect(calls.paid).toBe(1)
  const { meter } = await ledgers()
  expect(meter.map(r => r.decision)).toEqual(['allow', 'would_block'])
})

it('#3 import classify: one meter row in shadow', async () => {
  const headers = await freeOrg()
  const calls = providers()
  const response = await app.request('http://127.0.0.1/api/v1/import/classify', { method: 'POST', headers,
    body: JSON.stringify({ projectId: PROJECT, fileName: 'rows.txt', sample: 'kind|source\nverse|Text' }) }, settings('shadow'))
  expect(response.status, await response.clone().text()).toBe(200)
  await expectOneRowPerCall(calls, 'llm')
})

it('#4 smart edits LLM: one meter row in shadow', async () => {
  const headers = await freeOrg()
  const calls = providers()
  const response = await app.request('http://127.0.0.1/api/v1/ai/smart-edits/llm', { method: 'POST', headers,
    body: JSON.stringify({ projectId: PROJECT, fileId: FILE, cellId: 'c1', source: 'In the beginning', target: 'Mwanzo' }) },
  settings('shadow'))
  expect(response.status, await response.clone().text()).toBe(200)
  await expectOneRowPerCall(calls, 'llm')
})

it('#5 segmentation: one meter row per model call in shadow', async () => {
  const headers = await freeOrg()
  const calls = providers()
  const response = await app.request(`http://127.0.0.1/api/v2/projects/${PROJECT}/contextual/segmentation/generate?fileId=${FILE}`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }, settings('shadow'))
  expect(response.status, await response.clone().text()).toBe(200)
  await expectOneRowPerCall(calls, 'agent')
})

it('#2 agent run: one meter row per orchestrator turn in shadow', async () => {
  const headers = await freeOrg()
  const calls = providers()
  const response = await app.request('http://127.0.0.1/api/v1/ai/agent/run', { method: 'POST', headers,
    body: JSON.stringify({ projectId: PROJECT, messages: [{ role: 'user', content: 'Anything to do?' }], context: { fileId: FILE } }),
  }, settings('shadow'))
  expect(response.status).toBe(200)
  await response.text()
  await expectOneRowPerCall(calls, 'agent')
})

it('#6 autopilot tick: one meter row per graph call, billed to the person who started the run', async () => {
  const headers = await freeOrg()
  const calls = providers()
  const response = await app.request(`http://127.0.0.1/api/v2/projects/${PROJECT}/contextual/runs`, { method: 'POST', headers,
    body: JSON.stringify({ fileId: FILE }) }, settings('shadow'))
  expect(response.status, await response.clone().text()).toBe(201)
  if (_test.lastLoop) await _test.lastLoop
  await expectOneRowPerCall(calls, 'agent')
  expect((await ledgers()).meter.every(r => r.user_id === 1)).toBe(true)
})

it('#9 a reaction run has no role snapshot: it is metered as the system user instead of failing', async () => {
  await freeOrg()
  const calls = providers()
  const started = await startReactionRun(settings('shadow'), {
    projectId: PROJECT, fileId: FILE, laneId: 'sh-tgt', targetLang: '', anchorCellId: 'c1', direction: 'Keep it plain.',
  })
  expect(started.status).toBe('ok')
  if (started.status !== 'ok') return
  await started.done
  // Before AQU-2062 a metered reaction run threw usage_workspace_unavailable.
  expect((await getRun(env.AQUILLA_PG, started.runId))?.status).not.toBe('failed')
  await expectOneRowPerCall(calls, 'agent')
  expect((await ledgers()).meter.every(r => r.user_id === null)).toBe(true)
})

it('#7 Whisper transcription: one meter row on the audio rail in shadow', async () => {
  const headers = await freeOrg()
  const calls = providers()
  const response = await app.request('http://127.0.0.1/api/v1/audio/transcriptions', { method: 'POST', headers,
    body: JSON.stringify(await buildTranscriptionRequest(new Float32Array(16000), PROJECT)) }, settings('shadow'))
  expect(response.status, await response.clone().text()).toBe(200)
  await expectOneRowPerCall(calls, 'audio')
})

it('#8 Omnilingual transcription and #27 its warm-up: one meter row each on the gpu rail', async () => {
  const headers = await freeOrg()
  const calls = providers()
  const warm = await app.request('http://127.0.0.1/api/v1/audio/transcriptions/warm', { method: 'POST', headers,
    body: JSON.stringify({ projectId: PROJECT, model: 'omni-ctc' }) }, settings('shadow'))
  expect(warm.status, await warm.clone().text()).toBe(202)
  const response = await app.request('http://127.0.0.1/api/v1/audio/transcriptions', { method: 'POST', headers,
    body: JSON.stringify({ ...(await buildTranscriptionRequest(new Float32Array(16000), PROJECT)), model: 'omni-ctc' }) },
  settings('shadow'))
  expect(response.status, await response.clone().text()).toBe(200)
  await expectOneRowPerCall(calls, 'gpu')
})
