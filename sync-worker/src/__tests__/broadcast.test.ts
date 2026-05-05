// Tests for broadcastRealtime (events/broadcast.ts).
//
// Mocks the FileSync DO namespace to avoid needing a real partyserver runtime.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RealtimeMessage } from '../events/realtime'
import type { BroadcastEnv } from '../events/broadcast'

const SECRET = 'bcast-secret'

// ── Stub helpers ──────────────────────────────────────────────────────────────

function makeStubFetch(status = 200) {
  return vi.fn().mockResolvedValue(new Response(null, { status }))
}

function makeStubNamespace(fetch: ReturnType<typeof makeStubFetch>) {
  const stub = { fetch }
  const ns = {
    idFromName: vi.fn().mockReturnValue('fake-do-id'),
    get: vi.fn().mockReturnValue(stub),
  }
  return { ns, stub }
}

// Mirrors the pattern used by archive-broadcast.ts. We mock 'partyserver' so
// getServerByName resolves to our stub DO, without needing a real DO runtime.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn(),
}))

// Re-import after mock is registered.
import { getServerByName } from 'partyserver'
import { broadcastRealtime } from '../events/broadcast'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetServerByName = getServerByName as any

function makeEnv(overrides: Partial<BroadcastEnv> = {}): BroadcastEnv {
  return {
    FileSync: {} as DurableObjectNamespace,
    SYNC_SECRET_KEY: SECRET,
    ...overrides,
  }
}

function makeEventMessage(overrides: Partial<RealtimeMessage & { t: 'event' }> = {}): Extract<RealtimeMessage, { t: 'event' }> {
  return {
    v: 1,
    t: 'event',
    id: 'evt-001',
    kind: 'cell.commit',
    project: 'proj-a',
    file: 'file-x',
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

  it('skips messages that have no file property', async () => {
    const msg: RealtimeMessage = {
      v: 1,
      t: 'projection.dirty',
      project: 'proj-a',
      // No file — can't route to per-file DO.
      tables: ['cells'],
    }
    await broadcastRealtime(makeEnv(), msg)
    expect(mockGetServerByName).not.toHaveBeenCalled()
  })

  it('skips when SYNC_SECRET_KEY is missing', async () => {
    const msg = makeEventMessage()
    await broadcastRealtime(makeEnv({ SYNC_SECRET_KEY: undefined }), msg)
    expect(mockGetServerByName).not.toHaveBeenCalled()
  })

  it('calls getServerByName with the correct docName', async () => {
    const fetchSpy = makeStubFetch()
    mockGetServerByName.mockResolvedValue({ fetch: fetchSpy })

    const msg = makeEventMessage({ project: 'proj-a', file: 'file-x' })
    await broadcastRealtime(makeEnv(), msg)

    expect(mockGetServerByName).toHaveBeenCalledWith(
      expect.anything(),  // FileSync namespace
      'proj-a--file-x',
    )
  })

  it('sends POST to /__broadcast with serialized message and bearer auth', async () => {
    const fetchSpy = makeStubFetch()
    mockGetServerByName.mockResolvedValue({ fetch: fetchSpy })

    const msg = makeEventMessage()
    await broadcastRealtime(makeEnv(), msg)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://do.internal/__broadcast')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${SECRET}`)
    // Body should be the serialized message.
    const body = JSON.parse(init.body as string)
    expect(body.t).toBe('event')
    expect(body.id).toBe('evt-001')
  })

  it('sends projection.dirty message correctly', async () => {
    const fetchSpy = makeStubFetch()
    mockGetServerByName.mockResolvedValue({ fetch: fetchSpy })

    const msg = makeDirtyMessage({ tables: ['cells', 'files'] })
    await broadcastRealtime(makeEnv(), msg)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.t).toBe('projection.dirty')
    expect(body.tables).toEqual(['cells', 'files'])
  })

  it('does not throw when DO returns non-2xx', async () => {
    const fetchSpy = makeStubFetch(500)
    mockGetServerByName.mockResolvedValue({ fetch: fetchSpy })

    const msg = makeEventMessage()
    // Should not throw.
    await expect(broadcastRealtime(makeEnv(), msg)).resolves.toBeUndefined()
  })

  it('does not throw when DO fetch throws', async () => {
    mockGetServerByName.mockResolvedValue({
      fetch: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    })

    const msg = makeEventMessage()
    await expect(broadcastRealtime(makeEnv(), msg)).resolves.toBeUndefined()
  })

  it('does not throw when getServerByName throws', async () => {
    mockGetServerByName.mockRejectedValue(new Error('namespace unavailable'))

    const msg = makeEventMessage()
    await expect(broadcastRealtime(makeEnv(), msg)).resolves.toBeUndefined()
  })
})
