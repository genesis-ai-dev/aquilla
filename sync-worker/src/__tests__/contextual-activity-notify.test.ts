import { describe, expect, it } from 'vitest'
import { handleContextualActivityRequest } from '../contextual-activity-notify'
import { parseContextualFrame } from '../contextual-frames'

const SECRET = 'contextual-notify-secret'

function makeEnv(calls: Array<{ url: string; init?: RequestInit }>) {
  return {
    SYNC_SECRET_KEY: SECRET,
    ProjectSync: {
      idFromName: (projectId: string) => projectId,
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          calls.push({ url, init })
          return Response.json({ ok: true })
        },
      }),
    },
  } as unknown as Parameters<typeof handleContextualActivityRequest>[1]
}

function post(body: unknown, headers?: HeadersInit) {
  return new Request('https://worker/admin/projects/project-1/contextual-activity', {
    method: 'POST',
    headers: headers ?? { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('contextual activity realtime notification', () => {
  it('authenticates the pipeline and relays the frame through ProjectSync as contextual.activity', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const frame = {
      type: 'contextual.run.state',
      runId: 'run-1',
      fileId: 'file-1',
      targetLang: '',
      status: 'running',
      done: 3,
      total: 12,
    }
    const response = await handleContextualActivityRequest(post(frame), makeEnv(calls))

    expect(response?.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://do.internal/__broadcast')
    expect(calls[0].init?.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` })
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      t: 'contextual.activity', project: 'project-1', frame,
    })
  })

  it('accepts and relays the auth route producer\'s pausing state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const frame = {
      type: 'contextual.run.state',
      runId: 'run-pausing',
      fileId: 'file-1',
      targetLang: '',
      status: 'pausing',
      done: 3,
      total: 12,
      failed: 0,
    }
    const response = await handleContextualActivityRequest(post(frame), makeEnv(calls))
    expect(response?.status).toBe(200)
    expect(JSON.parse(calls[0].init?.body as string).frame).toEqual(frame)
  })

  it('relays scene and span frames verbatim (field names are the SPA wire contract)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const env = makeEnv(calls)
    const scene = {
      type: 'contextual.scene',
      runId: 'run-1',
      sceneBriefId: 'brief-9',
      spanLabel: 'LUK 1:1–1:8',
      ambiguityCount: 2,
    }
    const span = {
      type: 'contextual.span',
      runId: 'run-1',
      spanLabel: 'LUK 1:1–1:8',
      staged: 7,
      skipped: 1,
      verdictSummary: '7 staged, 1 skipped',
      outcome: 'partial',
      reasons: ['rejected_by_quorum'],
      calls: 9,
      units: 21,
    }
    expect((await handleContextualActivityRequest(post(scene), env))?.status).toBe(200)
    expect((await handleContextualActivityRequest(post(span), env))?.status).toBe(200)
    expect(calls.map((c) => JSON.parse(c.init?.body as string).frame)).toEqual([scene, span])
  })

  it('rejects unauthenticated, wrong-method, and malformed requests before touching the DO', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const env = makeEnv(calls)

    const unauthorized = await handleContextualActivityRequest(
      post({ type: 'contextual.run.state' }, { 'Content-Type': 'application/json' }),
      env,
    )
    expect(unauthorized?.status).toBe(401)

    const wrongMethod = await handleContextualActivityRequest(new Request(
      'https://worker/admin/projects/project-1/contextual-activity', { method: 'GET' },
    ), env)
    expect(wrongMethod?.status).toBe(405)

    const malformed = await handleContextualActivityRequest(
      post({ type: 'contextual.run.state', runId: 'run-1', fileId: 'f', targetLang: '', status: 'sideways', done: 0, total: 1 }),
      env,
    )
    expect(malformed?.status).toBe(400)

    const missingLane = await handleContextualActivityRequest(
      post({ type: 'contextual.run.state', runId: 'run-1', fileId: 'f', status: 'failed', done: 0, total: 1 }),
      env,
    )
    expect(missingLane?.status).toBe(400)

    const unknownType = await handleContextualActivityRequest(
      post({ type: 'contextual.mystery', runId: 'run-1' }),
      env,
    )
    expect(unknownType?.status).toBe(400)

    expect(calls).toHaveLength(0)
  })

  it('ignores non-matching paths so the router falls through', async () => {
    const response = await handleContextualActivityRequest(new Request(
      'https://worker/admin/projects/project-1/settings-changed', { method: 'POST' },
    ), makeEnv([]))
    expect(response).toBeNull()
  })

  it('still 200s when the DO broadcast fails — the run must not be affected', async () => {
    const env = {
      SYNC_SECRET_KEY: SECRET,
      ProjectSync: {
        idFromName: (projectId: string) => projectId,
        get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
      },
    } as unknown as Parameters<typeof handleContextualActivityRequest>[1]
    const response = await handleContextualActivityRequest(post({
      type: 'contextual.span', runId: 'run-1', spanLabel: 'LUK 2', staged: 1, skipped: 0, verdictSummary: 'ok',
    }), env)
    expect(response?.status).toBe(200)
  })
})

describe('parseContextualFrame', () => {
  it('accepts run.state with optional failed and preserves exact field names', () => {
    expect(parseContextualFrame({
      type: 'contextual.run.state', runId: 'r', fileId: 'f', targetLang: 'fr', status: 'paused', done: 1, total: 2, failed: 1,
    })).toEqual({
      type: 'contextual.run.state', runId: 'r', fileId: 'f', targetLang: 'fr', status: 'paused', done: 1, total: 2, failed: 1,
    })
  })

  it('accepts the guarded pause transition status', () => {
    expect(parseContextualFrame({
      type: 'contextual.run.state', runId: 'r', fileId: 'f', targetLang: '', status: 'pausing', done: 1, total: 2,
    })).toMatchObject({ status: 'pausing' })
  })

  it('rejects missing runId, wrong field types, and non-objects', () => {
    expect(parseContextualFrame(null)).toBeNull()
    expect(parseContextualFrame('frame')).toBeNull()
    expect(parseContextualFrame({ type: 'contextual.scene', sceneBriefId: 'b', spanLabel: 's', ambiguityCount: 0 })).toBeNull()
    expect(parseContextualFrame({ type: 'contextual.span', runId: 'r', spanLabel: 's', staged: '7', skipped: 0, verdictSummary: '' })).toBeNull()
    expect(parseContextualFrame({
      type: 'contextual.run.state', runId: 'r', fileId: 'f', status: 'failed', done: 0, total: 1,
    })).toBeNull()
    expect(parseContextualFrame({
      type: 'contextual.drafts', runId: 'r', fileId: 'f', spanLabel: 's',
      drafts: [{ draftId: 'd', cellId: 'c', text: 'missing lane provenance' }],
    })).toBeNull()
  })

  it('preserves sanitized outcome metadata and authoritative draft counts', () => {
    expect(parseContextualFrame({
      type: 'contextual.span', runId: 'r', spanId: 's1', spanLabel: 'LUK 1',
      staged: 2, skipped: 1, verdictSummary: 'partial', outcome: 'partial',
      reasons: ['target_already_filled'], calls: 6, units: 14,
    })).toMatchObject({
      type: 'contextual.span', outcome: 'partial', reasons: ['target_already_filled'], calls: 6, units: 14,
    })
    expect(parseContextualFrame({
      type: 'contextual.drafts', runId: 'r', fileId: 'f', targetLang: '', spanId: 's1', spanLabel: 'LUK 1',
      draftCount: 55, drafts: [{ draftId: 'd1', cellId: 'c1', text: 'visible live payload' }], truncated: true,
    })).toMatchObject({
      type: 'contextual.drafts', targetLang: '', spanId: 's1', draftCount: 55, truncated: true,
    })
    expect(parseContextualFrame({
      type: 'contextual.drafts', runId: 'r', fileId: 'f', targetLang: '', spanLabel: 'LUK 1',
      draftCount: 1, drafts: [], truncated: true,
    })).toMatchObject({ type: 'contextual.drafts', drafts: [], truncated: true })

    // Free-form/model prose cannot masquerade as a durable reason code.
    expect(parseContextualFrame({
      type: 'contextual.span', runId: 'r', spanLabel: 's', staged: 0, skipped: 1,
      verdictSummary: 'failed', reasons: ['the model thought about it'],
    })).toBeNull()
  })
})
