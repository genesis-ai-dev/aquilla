// Tests for broadcastRealtime (events/broadcast.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RealtimeMessage } from '../events/realtime'
import type { BroadcastEnv } from '../events/broadcast'
import { broadcastRealtime } from '../events/broadcast'

const SECRET = 'bcast-secret'

function makeStubFetch(status = 200) {
  return vi.fn().mockResolvedValue(new Response(null, { status }))
}

function makeEnv(overrides: Partial<BroadcastEnv> = {}): BroadcastEnv {
  const fetch = makeStubFetch()
  const stub = { fetch }
  const projectSync = {
    idFromName: vi.fn().mockReturnValue('fake-project-do-id'),
    get: vi.fn().mockReturnValue(stub),
  } as any
  return {
    ProjectSync: projectSync as DurableObjectNamespace,
    SYNC_SECRET_KEY: SECRET,
    ...overrides,
  }
}

function makeEventMessage(overrides: Partial<Extract<RealtimeMessage, { t: 'event' }>> = {}): Extract<RealtimeMessage, { t: 'event' }> {
  return {
    v: 1,
    t: 'event',
    id: 'evt-001',
    kind: 'cell.commit',
    project: 'proj-a',
    file: 'file-x',
    cell: 'cell-1',
    ts: 12345,
    ...overrides,
  } as Extract<RealtimeMessage, { t: 'event' }>
}

function makeDirtyMessage(overrides: Partial<Extract<RealtimeMessage, { t: 'projection.dirty' }>> = {}): Extract<RealtimeMessage, { t: 'projection.dirty' }> {
  return {
    v: 1,
    t: 'projection.dirty',
    project: 'proj-a',
    file: 'file-x',
    tables: ['cells'],
    ...overrides,
  }
}

describe('broadcastRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips projection.dirty messages', async () => {
    const env = makeEnv()
    await broadcastRealtime(env, makeDirtyMessage())
    expect((env.ProjectSync as any).idFromName).not.toHaveBeenCalled()
  })

  it('skips when SYNC_SECRET_KEY is missing', async () => {
    const env = makeEnv({ SYNC_SECRET_KEY: undefined })
    await broadcastRealtime(env, makeEventMessage())
    expect((env.ProjectSync as any).idFromName).not.toHaveBeenCalled()
  })

  it('routes by project id', async () => {
    const env = makeEnv()
    await broadcastRealtime(env, makeEventMessage({ project: 'proj-a' }))
    expect((env.ProjectSync as any).idFromName).toHaveBeenCalledWith('proj-a')
    expect((env.ProjectSync as any).get).toHaveBeenCalledWith('fake-project-do-id')
  })

  it('sends ProjectSync event.applied with bearer auth', async () => {
    const env = makeEnv()
    const stub = (env.ProjectSync as any).get()
    await broadcastRealtime(env, makeEventMessage())

    expect(stub.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = stub.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://do.internal/__broadcast')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${SECRET}`)
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      t: 'event.applied',
      id: 'evt-001',
      kind: 'cell.commit',
      project: 'proj-a',
      file: 'file-x',
      cell: 'cell-1',
    })
  })

  it('does not throw when DO returns non-2xx', async () => {
    const env = makeEnv()
    const stub = (env.ProjectSync as any).get()
    stub.fetch.mockResolvedValue(new Response(null, { status: 500 }))
    await expect(broadcastRealtime(env, makeEventMessage())).resolves.toBeUndefined()
  })

  it('does not throw when DO fetch throws', async () => {
    const env = makeEnv()
    const stub = (env.ProjectSync as any).get()
    stub.fetch.mockRejectedValue(new Error('DO unavailable'))
    await expect(broadcastRealtime(env, makeEventMessage())).resolves.toBeUndefined()
  })

  it('does not throw when namespace lookup throws', async () => {
    const env = makeEnv()
    ;(env.ProjectSync as any).idFromName.mockImplementation(() => {
      throw new Error('namespace unavailable')
    })
    await expect(broadcastRealtime(env, makeEventMessage())).resolves.toBeUndefined()
  })
})
