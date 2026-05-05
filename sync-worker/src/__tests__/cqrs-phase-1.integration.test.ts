// Integration test: POST /events → DB write → broadcast → GET /events roundtrip.
//
// Uses in-memory D1 and a mock FileSync namespace. Does NOT use a real
// partyserver DO runtime — broadcast calls are intercepted at the
// getServerByName boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleEventsWriteRequest } from '../events/route'
import { handleEventsReadRequest } from '../events/read-route'
import { makeInMemoryD1 } from './helpers/d1-fake'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'
import type { RealtimeMessage } from '../events/realtime'

const SECRET = 'integration-secret'

// ── Mock partyserver so broadcastRealtime can call getServerByName ────────────

vi.mock('partyserver', () => ({
  getServerByName: vi.fn(),
}))

import { getServerByName } from 'partyserver'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetServerByName = getServerByName as any

// ── Mock broadcastRealtime so we can spy on message-level calls ───────────────
//
// We spy on the broadcast module to capture RealtimeMessage objects directly.
// This lets the 100-event test assert on message counts and content without
// parsing serialized JSON from fetch bodies.

vi.mock('../events/broadcast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/broadcast')>()
  return {
    ...actual,
    broadcastRealtime: vi.fn(actual.broadcastRealtime),
  }
})

import { broadcastRealtime } from '../events/broadcast'
const broadcastSpy = broadcastRealtime as ReturnType<typeof vi.fn>

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-a',
    fileId: 'file-x',
    ...overrides,
  } as any)
}

function makeCommitEvent(overrides: Partial<RawEvent<'cell.commit'>> = {}): RawEvent<'cell.commit'> {
  return {
    id: 'evt-integration-001',
    schemaVersion: 1,
    kind: 'cell.commit',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    author: 'alice',
    payload: { value: 'integration test content', valueHtml: '<p>integration test</p>' },
    clientTs: 1000,
    ...overrides,
  }
}

async function postEvents(
  events: unknown[],
  env: Record<string, unknown>,
  token: string,
): Promise<Response> {
  const req = new Request('http://localhost/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events }),
  })
  return (await handleEventsWriteRequest(req, env as any))!
}

async function getEvents(
  params: Record<string, string>,
  env: Record<string, unknown>,
  token: string,
): Promise<Response> {
  const url = new URL('http://localhost/events')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const req = new Request(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  return (await handleEventsReadRequest(req, env as any))!
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CQRS Phase 1 integration: POST → DB → broadcast → GET', () => {
  let broadcastFetchSpy: ReturnType<typeof vi.fn>
  let capturedBroadcasts: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    capturedBroadcasts = []
    broadcastFetchSpy = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      if (typeof init.body === 'string') capturedBroadcasts.push(init.body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    mockGetServerByName.mockResolvedValue({ fetch: broadcastFetchSpy })
  })

  it('writes event and cell projection to D1, then broadcasts, then GET returns the event', async () => {
    const db = makeInMemoryD1()
    const FileSync = {} as DurableObjectNamespace
    const env = { CODEX_DB: db, SYNC_SECRET_KEY: SECRET, FileSync }

    const token = await makeToken()
    const event = makeCommitEvent()

    // POST /events
    const postRes = await postEvents([event], env, token)
    expect(postRes.status).toBe(200)
    const postBody = await postRes.json() as { accepted: Array<{ id: string }>, rejected: unknown[] }
    expect(postBody.accepted).toHaveLength(1)
    expect(postBody.accepted[0].id).toBe('evt-integration-001')
    expect(postBody.rejected).toHaveLength(0)

    // Verify events table has the row.
    const tables = db._tables()
    expect(tables.events).toHaveLength(1)
    expect(tables.events[0].id).toBe('evt-integration-001')
    expect(tables.events[0].project_id).toBe('proj-a')
    expect(tables.events[0].file_id).toBe('file-x')

    // Verify cells projection has the upserted row.
    expect(tables.cells).toHaveLength(1)
    expect(tables.cells[0].cell_id).toBe('cell-1')
    expect(tables.cells[0].file_id).toBe('file-x')

    // Verify broadcastRealtime was called with the event frame.
    expect(broadcastFetchSpy).toHaveBeenCalled()
    const broadcastBodies = capturedBroadcasts.map((b) => JSON.parse(b) as RealtimeMessage)

    // Should have at least one 'event' message.
    const eventFrames = broadcastBodies.filter((m) => m.t === 'event')
    expect(eventFrames).toHaveLength(1)
    expect(eventFrames[0]).toMatchObject({
      v: 1,
      t: 'event',
      kind: 'cell.commit',
      project: 'proj-a',
      file: 'file-x',
    })

    // Should have at least one 'projection.dirty' message.
    const dirtyFrames = broadcastBodies.filter((m) => m.t === 'projection.dirty')
    expect(dirtyFrames).toHaveLength(1)
    expect(dirtyFrames[0]).toMatchObject({
      v: 1,
      t: 'projection.dirty',
      project: 'proj-a',
      file: 'file-x',
    })
    // cells should be in the dirty tables (cell.commit projects cells).
    const dirtyTables = (dirtyFrames[0] as Extract<RealtimeMessage, { t: 'projection.dirty' }>).tables
    expect(dirtyTables).toContain('cells')

    // GET /events?fileId=file-x — should return the committed event.
    const getRes = await getEvents({ fileId: 'file-x' }, env, token)
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json() as { events: Array<Record<string, unknown>> }
    expect(getBody.events).toHaveLength(1)
    const returnedEvent = getBody.events[0]
    expect(returnedEvent.id).toBe('evt-integration-001')
    expect(returnedEvent.kind).toBe('cell.commit')
    expect(returnedEvent.projectId).toBe('proj-a')
    expect(returnedEvent.fileId).toBe('file-x')
    expect(returnedEvent.cellId).toBe('cell-1')
    expect(returnedEvent.author).toBe('alice')
    // Payload should be parsed JSON.
    expect(returnedEvent.payload).toEqual({
      value: 'integration test content',
      valueHtml: '<p>integration test</p>',
    })
  })

  it('broadcast is skipped when FileSync is absent (no env binding)', async () => {
    const db = makeInMemoryD1()
    // No FileSync in env — should not call getServerByName.
    const env = { CODEX_DB: db, SYNC_SECRET_KEY: SECRET }

    const token = await makeToken()
    const postRes = await postEvents([makeCommitEvent()], env, token)
    expect(postRes.status).toBe(200)
    expect(mockGetServerByName).not.toHaveBeenCalled()
  })

  it('broadcast failure does not prevent accepted response', async () => {
    broadcastFetchSpy = vi.fn().mockRejectedValue(new Error('DO unreachable'))
    mockGetServerByName.mockResolvedValue({ fetch: broadcastFetchSpy })

    const db = makeInMemoryD1()
    const env = { CODEX_DB: db, SYNC_SECRET_KEY: SECRET, FileSync: {} as DurableObjectNamespace }
    const token = await makeToken()

    const postRes = await postEvents([makeCommitEvent()], env, token)
    expect(postRes.status).toBe(200)
    const body = await postRes.json() as { accepted: unknown[], rejected: unknown[] }
    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(0)
  })

  it('GET /events returns only events for the requested fileId', async () => {
    const db = makeInMemoryD1()
    const env = { CODEX_DB: db, SYNC_SECRET_KEY: SECRET }
    const tokenX = await makeToken({ fileId: 'file-x' })
    const tokenY = await makeToken({ fileId: 'file-y' })

    // Insert an event for file-x directly.
    await db.batch([
      db.prepare(
        'INSERT OR IGNORE INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind('evt-x', 1, 'proj-a', 'file-x', 'cell-1', 'cell.commit', 'alice', '{}', 100, 200),
      db.prepare(
        'INSERT OR IGNORE INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind('evt-y', 1, 'proj-a', 'file-y', 'cell-2', 'cell.commit', 'bob', '{}', 100, 300),
    ])

    const resX = await getEvents({ fileId: 'file-x' }, env, tokenX)
    const bodyX = await resX.json() as { events: Array<{ id: string }> }
    expect(bodyX.events.map((e) => e.id)).toEqual(['evt-x'])

    const resY = await getEvents({ fileId: 'file-y' }, env, tokenY)
    const bodyY = await resY.json() as { events: Array<{ id: string }> }
    expect(bodyY.events.map((e) => e.id)).toEqual(['evt-y'])
  })

  it("posts 100 cell.commit events; D1 has 100 rows; projection has 1 cell row; broadcast called 101 times (100 events + 1 coalesced dirty)", async () => {
    // Setup: D1 fake, broadcast mock, 100 events with sequential clientTs
    // and shared (project, file, cell) so the projection.dirty coalesces.
    const d1 = makeInMemoryD1()
    const FileSync = {} as DurableObjectNamespace
    const env = { CODEX_DB: d1, SYNC_SECRET_KEY: SECRET, FileSync }
    const token = await makeToken({ projectId: 'p1', fileId: 'f1' })

    const events: RawEvent<'cell.commit'>[] = []
    for (let i = 0; i < 100; i++) {
      events.push({
        id: `evt-${String(i).padStart(3, '0')}`,
        schemaVersion: 1,
        kind: 'cell.commit',
        projectId: 'p1',
        fileId: 'f1',
        cellId: 'c1',
        author: 'ryder',
        payload: { value: `version ${i}`, valueHtml: `<p>version ${i}</p>` },
        clientTs: 1_000_000 + i,
      })
    }

    const res = await handleEventsWriteRequest(
      new Request('http://w/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      }),
      env,
    )
    expect(res?.status).toBe(200)
    const body = await res!.json() as { accepted: Array<{ id: string }>, rejected: unknown[] }
    expect(body.accepted).toHaveLength(100)
    expect(body.rejected).toHaveLength(0)

    // 100 events × 2 stmts = 200 stmts → 2 D1 chunks. All committed.
    expect(d1._tables().events).toHaveLength(100)
    // All 100 commits are to the same cell, so cells projection has 1 row
    // (LWW guard ensures the highest server_ts wins; serverTs is shared
    // across all 100 events in this batch — last one wins).
    expect(d1._tables().cells).toHaveLength(1)

    // Broadcast: 100 'event' frames + 1 coalesced 'projection.dirty' frame
    // for the (p1, f1) scope with tables=['cells'] (or ['events','cells']).
    expect(broadcastSpy).toHaveBeenCalledTimes(101)
    const callArgs = broadcastSpy.mock.calls.map((c: unknown[]) => c[1] as RealtimeMessage)
    const eventFrames = callArgs.filter((m) => m.t === 'event')
    const dirtyFrames = callArgs.filter((m) => m.t === 'projection.dirty')
    expect(eventFrames).toHaveLength(100)
    expect(dirtyFrames).toHaveLength(1)
    expect(dirtyFrames[0]).toMatchObject({ project: 'p1', file: 'f1' })
    expect((dirtyFrames[0] as Extract<RealtimeMessage, { t: 'projection.dirty' }>).tables).toContain('cells')
  })
})
