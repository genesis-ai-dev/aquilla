// Agent API transcription (Omnilingual ASR spec §7) — the sync-worker half.
//
// auth-worker owns routing, the zero-shot org gate and billing (its own tests
// cover those); what this file proves is everything an agent relies on before
// and after that seam:
//  - only a project-scoped, read-write, contributor credential may spend credits;
//  - long WAV is cut server-side into windows the chosen model accepts, and
//    word timings come back on the WHOLE clip's clock;
//  - zero-shot learns from this lane's own recordings, ranked for the cell;
//  - upstream refusals reach the agent as stable codes with a next step;
//  - nothing is written: storing a transcript stays behind the changeset gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalTranscriptionRequest, takeFormat } from '../external/transcription-route'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { canonicalWavSamples, encodeCanonicalWav, toBase64, windowCanonicalWav, SAMPLE_RATE } from '../external/wav-windows'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-asr'
const FILE = 'file-a'
const LANE = 'luolane1'
const SRC_LANE = 'srclane1'
const SECRET = 'test-secret'
const AUTH_URL = 'https://identity.test'
const PUBLIC = 'https://api.test/sync'

let tdb: TestDb
let calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }>
let reply: (body: Record<string, unknown>) => Response

const objects: Record<string, Uint8Array> = {}
const bucket = {
  get: async (key: string) => key in objects
    ? { arrayBuffer: async () => objects[key].buffer.slice(0), body: new Blob([objects[key]]).stream(), size: objects[key].length }
    : null,
} as unknown as R2Bucket

function makeEnv() {
  return {
    AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET, AUTH_WORKER_URL: AUTH_URL,
    BASE_URL: 'https://aquilla.app', SNAPSHOTS: bucket, DIARIZATION_PUBLIC_BASE: PUBLIC,
  }
}

let credSeq = 0
async function credToken(spec: { userId: number; access?: 'read' | 'write'; projectId?: string | null }) {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h') ON CONFLICT (id) DO NOTHING`,
    [spec.userId, `u${spec.userId}`, `u${spec.userId}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  credSeq += 1
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, access, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, NULL, $6)`,
    [`00000000-0000-0000-0000-${String(credSeq).padStart(12, '0')}`, String(spec.userId), tokenPrefix, tokenHash,
      spec.access ?? 'write', spec.projectId === undefined ? PROJECT : spec.projectId],
  )
  return token
}

const post = (token: string, body: unknown, status = false) => handleExternalTranscriptionRequest(
  new Request(`https://w/api/v1/external/projects/${PROJECT}/transcriptions${status ? '/status' : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  makeEnv(),
) as Promise<Response>

/** A canonical WAV of `seconds`, loud except for silent 50 ms gaps at `quietAt`. */
function wav(seconds: number, quietAt: number[] = []): string {
  const samples = new Int16Array(Math.round(seconds * SAMPLE_RATE)).fill(8000)
  for (const at of quietAt) samples.fill(0, Math.round(at * SAMPLE_RATE), Math.round((at + 0.05) * SAMPLE_RATE))
  return toBase64(encodeCanonicalWav(samples))
}

const take = (cell: string, durationMs: number, extra: Record<string, unknown> = {}) => ({
  project_id: PROJECT, file_id: FILE, cell_id: cell, audio_id: `${cell}.webm`, slot: 'recording',
  url: `frontier-audio://${cell}.webm`, mime_type: 'audio/webm', duration_ms: durationMs, lane_id: LANE,
  selected: 1, deleted: 0, role: 'dub', event_id: `ev-${cell}`, created_ts: 1, ...extra,
})
const cellRows = (id: string, source: string, target: string) => [
  { project_id: PROJECT, file_id: FILE, cell_id: id, side: 'source', value: source, lane_id: SRC_LANE, event_id: `s-${id}`, last_edit_at: 1 },
  { project_id: PROJECT, file_id: FILE, cell_id: id, side: 'target', value: target, lane_id: LANE, event_id: `t-${id}`, last_edit_at: 1 },
]

beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'Dholuo', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 2, role_level: 400 }, // contributor
      { project_id: PROJECT, user_id: 3, role_level: 100 }, // viewer
    ],
    lanes: [
      { id: SRC_LANE, project_id: PROJECT, role: 'source', name: 'English', lang_code: 'en', legacy_tag: null },
      { id: LANE, project_id: PROJECT, role: 'target', name: 'Dholuo', language: 'Dholuo', lang_code: 'luo', legacy_tag: '' },
    ],
    cells: [
      ...cellRows('c-new', 'in the beginning was the word', ''),
      ...cellRows('c-similar', 'in the beginning god created', 'e chakruok'),
      ...cellRows('c-other', 'blessed are the meek', 'joma mool'),
    ],
    cell_audio: [take('c-new', 9000), take('c-similar', 8000), take('c-other', 7000)],
  })
  for (const k of Object.keys(objects)) delete objects[k]
  objects[`projects/${PROJECT}/files/${FILE}/audio/c-new.webm`] = new TextEncoder().encode('webm-bytes')
  calls = []
  reply = () => Response.json({ text: 'ami', chunks: [{ text: 'ami', start: 0.5, end: 1 }], model: 'omni-ctc', timingsApproximate: false, creditsCharged: 0.25 })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization'), body })
    return reply(body)
  }))
})
afterEach(async () => { vi.unstubAllGlobals(); await tdb.close() })

describe('credentials', () => {
  it('refuses an unscoped credential, a read-only one, and a viewer before any spend', async () => {
    const audio = { data: wav(2), format: 'wav' }
    const unscoped = await post(await credToken({ userId: 2, projectId: null }), { audio, language: 'luo' })
    expect(unscoped.status).toBe(403)
    expect(((await unscoped.json()) as { error: { code: string } }).error.code).toBe('scope_denied')
    expect((await post(await credToken({ userId: 2, access: 'read' }), { audio, language: 'luo' })).status).toBe(403)
    expect((await post(await credToken({ userId: 3 }), { audio, language: 'luo' })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe('raw WAV', () => {
  it('cuts 70 s into ≤30 s Omnilingual windows at quiet points and re-times words to the whole clip', async () => {
    const token = await credToken({ userId: 2 })
    const response = await post(token, { audio: { data: wav(70, [29, 58.5]), format: 'wav' }, language: 'luo' })
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.url).toBe(`${AUTH_URL}/api/v1/audio/internal/transcriptions`)
      expect(call.auth).toBe(`Bearer ${SECRET}`)
      expect(call.body).toMatchObject({ projectId: PROJECT, userId: '2', model: 'omni-ctc', language: 'luo' })
      const samples = canonicalWavSamples(Uint8Array.from(atob((call.body.audio as { data: string }).data), c => c.charCodeAt(0)))!
      expect(samples.length / SAMPLE_RATE).toBeLessThanOrEqual(30)
    }
    const body = (await response.json()) as { text: string; words: Array<{ start: number }>; model: string; creditsCharged: number }
    expect(body.model).toBe('omni-ctc')
    expect(body.text).toBe('ami ami ami')
    // Window 2 starts at the quiet gap near 29 s, so its word sits at ~29.5 s.
    expect(body.words[1].start).toBeCloseTo(29.5, 1)
    expect(body.creditsCharged).toBeCloseTo(0.75)
  })

  it('uses 60 s windows for Whisper', async () => {
    const token = await credToken({ userId: 2 })
    reply = () => Response.json({ text: 'hi', chunks: [], model: 'whisper', timingsApproximate: false, creditsCharged: 0.1 })
    expect((await post(token, { audio: { data: wav(70), format: 'wav' }, language: 'en' })).status).toBe(200)
    expect(calls.map(c => c.body.model)).toEqual(['whisper', 'whisper'])
  })

  it('rejects audio that is not canonical WAV', async () => {
    const token = await credToken({ userId: 2 })
    const res = await post(token, { audio: { data: btoa('not a wav'), format: 'wav' }, language: 'luo' })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('windows quietly: boundaries never move more than 2 s back', () => {
    const samples = new Int16Array(65 * SAMPLE_RATE).fill(8000)
    const windows = windowCanonicalWav(samples, 30)
    expect(windows.map(w => w.offsetSeconds)).toEqual([0, 30, 60])
  })
})

describe("a cell's take, zero-shot", () => {
  it("forwards the stored webm and this lane's best examples, ranked by the cell's source text", async () => {
    const token = await credToken({ userId: 2 })
    const response = await post(token, { laneId: LANE, fileId: FILE, cellId: 'c-new', model: 'omni-zs' })
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    const sent = calls[0].body as { audio: { data: string; format: string; durationMs: number }; examples: Array<{ url: string; text: string }>; language: string }
    expect(sent.audio).toEqual({ data: btoa('webm-bytes'), format: 'webm', durationMs: 9000 })
    expect(sent.language).toBe('luo')
    // The cell itself is never its own example; the one sharing its words leads.
    expect(sent.examples.map(e => e.text)).toEqual(['e chakruok', 'joma mool'])
    expect(sent.examples[0].url.startsWith(`${PUBLIC}/api/v1/transcription-examples/audio?`)).toBe(true)
  })

  it('learns only from the cells an agent names', async () => {
    const token = await credToken({ userId: 2 })
    await post(token, { laneId: LANE, fileId: FILE, cellId: 'c-new', model: 'omni-zs', exampleCellIds: ['c-other'] })
    expect((calls[0].body.examples as Array<{ text: string }>).map(e => e.text)).toEqual(['joma mool'])
  })

  it('reports zs_no_examples without calling auth-worker when the lane has none', async () => {
    const token = await credToken({ userId: 2 })
    const res = await post(token, { laneId: LANE, fileId: FILE, cellId: 'c-new', model: 'omni-zs', exampleCellIds: ['nope'] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('zs_no_examples')
    expect(calls).toHaveLength(0)
  })

  it('refuses a compressed take longer than one window instead of truncating it', async () => {
    await tdb.pg.query(`UPDATE cell_audio SET duration_ms = 45000 WHERE cell_id = 'c-new'`)
    const token = await credToken({ userId: 2 })
    const res = await post(token, { laneId: LANE, fileId: FILE, cellId: 'c-new', model: 'omni-ctc' })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('upstream refusals', () => {
  it('turns a cold zero-shot model into a retryable job_failed with the next step', async () => {
    const token = await credToken({ userId: 2 })
    reply = () => Response.json({ error: 'asr_warming' }, { status: 503, headers: { 'Retry-After': '10' } })
    const res = await post(token, { laneId: LANE, fileId: FILE, cellId: 'c-new', model: 'omni-zs' })
    const body = (await res.json()) as { error: { code: string; details: { reason: string; retryAfterSeconds: number; nextStep: string } } }
    expect(body.error.code).toBe('job_failed')
    expect(body.error.details).toMatchObject({ reason: 'asr_warming', retryAfterSeconds: 10 })
    expect(body.error.details.nextStep).toContain('transcription_status')
  })

  it('surfaces an org that turned zero-shot off as permission_denied', async () => {
    const token = await credToken({ userId: 2 })
    reply = () => Response.json({ error: 'zero_shot_disabled' }, { status: 403 })
    const res = await post(token, { laneId: LANE, fileId: FILE, cellId: 'c-new', model: 'omni-zs' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('permission_denied')
  })
})

describe('read-only output', () => {
  it('writes no events, cells or changesets', async () => {
    const token = await credToken({ userId: 2 })
    const before = await tdb.snapshot()
    expect((await post(token, { laneId: LANE, fileId: FILE, cellId: 'c-new', model: 'omni-ctc' })).status).toBe(200)
    const after = await tdb.snapshot()
    for (const table of ['events', 'cells', 'cell_audio', 'external_changesets']) {
      expect(after[table] ?? [], table).toEqual(before[table] ?? [])
    }
  })
})

describe('transcription_status', () => {
  it.each([false, true])('routes model status with warm=%s through MCP', async (warm) => {
    const token = await credToken({ userId: 2 })
    reply = () => Response.json({ state: 'starting', estGpuSecPerAudioSec: 0.5 })
    const res = await handleExternalMcpRequest(new Request('https://w/api/v1/external/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'transcription_status', arguments: { projectId: PROJECT, model: 'omni-zs', warm },
      } }),
    }), makeEnv())
    const body = await res!.json() as { result: { content: { text: string }[]; isError?: boolean } }
    expect(body.result.isError).not.toBe(true)
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ state: 'starting', estGpuSecPerAudioSec: 0.5 })
    expect(calls[0]).toMatchObject({
      url: `${AUTH_URL}/api/v1/audio/internal/transcriptions/status`,
      body: { projectId: PROJECT, userId: '2', model: 'omni-zs', action: warm ? 'warm' : 'status' },
    })
  })
})

describe('MCP + discovery', () => {
  it('prefers the identity service binding for the actual transcription request', async () => {
    const token = await credToken({ userId: 2 })
    const serviceFetch = fetch
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('public route must not be used') }))
    const response = await handleExternalTranscriptionRequest(new Request(`https://w/api/v1/external/projects/${PROJECT}/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: { data: wav(1), format: 'wav' }, language: 'luo', model: 'omni-ctc' }),
    }), { ...makeEnv(), AUTH_WORKER: { fetch: serviceFetch } })
    expect(response!.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ auth: `Bearer ${SECRET}`, body: { projectId: PROJECT, userId: '2', language: 'luo' } })
  })

  it('transcribe_audio over MCP reaches the same route', async () => {
    const token = await credToken({ userId: 2 })
    const res = await handleExternalMcpRequest(new Request('https://w/api/v1/external/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'transcribe_audio', arguments: { projectId: PROJECT, audio: { data: wav(2), format: 'wav' }, language: 'luo' },
      } }),
    }), makeEnv())
    const rpc = (await res!.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    expect(rpc.result.isError).not.toBe(true)
    expect(JSON.parse(rpc.result.content[0].text)).toMatchObject({ text: 'ami', model: 'omni-ctc' })
    expect(calls).toHaveLength(1)
  })

  it('publishes both endpoints', async () => {
    const map = (await handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))!.json()) as { endpoints: Record<string, string> }
    expect(Object.keys(map.endpoints)).toEqual(expect.arrayContaining([
      'POST /api/v1/external/projects/:projectId/transcriptions',
      'POST /api/v1/external/projects/:projectId/transcriptions/status',
    ]))
  })

  it('reads a take format from its mime type, else its extension', () => {
    expect(takeFormat('audio/webm;codecs=opus', 'a.bin')).toBe('webm')
    expect(takeFormat(null, 'a.ogg')).toBe('ogg')
    expect(takeFormat(null, 'a.xyz')).toBeUndefined()
  })
})
