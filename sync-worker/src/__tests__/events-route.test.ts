// Tests for handleEventsWriteRequest (POST /events) under AD-2 / AD-9.

import { describe, it, expect, vi } from 'vitest'

// route.ts imports broadcast.ts → partyserver (cloudflare:* imports).
// Mock partyserver so Node's ESM loader doesn't choke.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-a',
    fileId: 'file-x',
    ...overrides,
  } as any)
}

function targetCreate(
  overrides: Partial<RawEvent<'target.cell.create'>> = {},
): RawEvent<'target.cell.create'> {
  return {
    id: 'evt-create-001',
    schemaVersion: 1,
    kind: 'target.cell.create',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: null,
    author: 'alice',
    payload: { cellId: 'cell-1', value: 'hello', valueHtml: '<p>hello</p>' },
    clientTs: 1000,
    ...overrides,
  }
}

function targetCommit(
  overrides: Partial<RawEvent<'target.cell.commit'>> = {},
): RawEvent<'target.cell.commit'> {
  return {
    id: 'evt-commit-001',
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: 'evt-create-001',
    author: 'alice',
    payload: { value: 'updated', valueHtml: '<p>updated</p>' },
    clientTs: 2000,
    ...overrides,
  }
}

function sourceCreate(
  overrides: Partial<RawEvent<'source.cell.create'>> = {},
): RawEvent<'source.cell.create'> {
  return {
    id: 'evt-src-create-001',
    schemaVersion: 1,
    kind: 'source.cell.create',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: null,
    author: 'import-bot',
    payload: { cellId: 'cell-1', value: 'source text' },
    clientTs: 0,
    ...overrides,
  }
}

function validate(
  overrides: Partial<RawEvent<'cell.validate'>> = {},
): RawEvent<'cell.validate'> {
  return {
    id: 'evt-validate-001',
    schemaVersion: 1,
    kind: 'cell.validate',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    parentId: 'evt-create-001',
    author: 'bob',
    payload: { editEventId: 'evt-create-001' },
    clientTs: 3000,
    ...overrides,
  }
}

function makeEnv(db?: AquillaDb, secret: string | undefined = SECRET) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: secret }
}

async function makeRequest(events: unknown[], token?: string): Promise<Request> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`
  return new Request('https://worker/events', {
    method: 'POST',
    headers,
    body: JSON.stringify({ events }),
  })
}

// ── URL / method / env / body ──────────────────────────────────────────

describe('POST /events — wiring', () => {
  it('returns null for non-/events URLs', async () => {
    const req = new Request('https://worker/admin/projects/p1/rebuild-projection', { method: 'POST' })
    expect(await handleEventsWriteRequest(req, makeEnv((await makeTestDb()).db))).toBeNull()
  })

  it('returns 405 for non-POST', async () => {
    const req = new Request('https://worker/events', { method: 'GET' })
    const res = (await handleEventsWriteRequest(req, makeEnv((await makeTestDb()).db)))!
    expect(res.status).toBe(405)
  })

  it('returns 500 when SYNC_SECRET_KEY missing', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    })
    const res = (await handleEventsWriteRequest(req, { AQUILLA_PG: (await makeTestDb()).db, SYNC_SECRET_KEY: undefined }))!
    expect(res.status).toBe(500)
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST', body: 'not json', headers: { 'Content-Type': 'text/plain' },
    })
    const res = (await handleEventsWriteRequest(req, makeEnv((await makeTestDb()).db)))!
    expect(res.status).toBe(400)
  })

  it('returns 200 with empty arrays for an empty batch', async () => {
    const token = await makeToken()
    const res = (await handleEventsWriteRequest(await makeRequest([], token), makeEnv((await makeTestDb()).db)))!
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.accepted).toEqual([])
    expect(body.rejected).toEqual([])
  })
})

// ── Author / authorization ─────────────────────────────────────────────

describe('POST /events — authorization', () => {
  it('writes the token username as the events.author (not the client-supplied author)', async () => {
    const token = await makeToken({ username: 'token-alice' })
    const event = targetCreate({ author: 'mallory' })
    const { db, snapshot } = await makeTestDb()
    await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db))
    const tables = (await snapshot())
    expect(tables.events[0].author).toBe('token-alice')
  })

  it('rejects source.cell.* from a CONTRIBUTOR token with 403', async () => {
    const token = await makeToken({ role: 400 })
    const event = sourceCreate()
    const { db, snapshot } = await makeTestDb()
    const res = (await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
  })

  it('accepts source.cell.* from a PROJECT_LEAD token', async () => {
    const token = await makeToken({ role: 500 })
    const event = sourceCreate()
    const { db, snapshot } = await makeTestDb()
    const res = (await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.accepted).toHaveLength(1)
    expect((await snapshot()).events[0].kind).toBe('source.cell.create')
  })

  it('rejects target.cell.commit from a COMMENTER token (< CONTRIBUTOR)', async () => {
    const token = await makeToken({ role: 200 })
    const event = targetCommit()
    const { db, snapshot } = await makeTestDb()
    const res = (await handleEventsWriteRequest(await makeRequest([event], token), makeEnv(db)))!
    const body = await res.json() as any
    expect(body.rejected[0].status).toBe(403)
  })
})

// ── server_seq monotonicity ────────────────────────────────────────────

describe('POST /events — server_seq', () => {
  it('assigns a monotonically increasing server_seq per project', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()
    const events = [
      targetCreate({ id: 'a', cellId: 'cell-1', payload: { cellId: 'cell-1', value: '1' } }),
      targetCreate({ id: 'b', cellId: 'cell-2', payload: { cellId: 'cell-2', value: '2' } }),
      targetCreate({ id: 'c', cellId: 'cell-3', payload: { cellId: 'cell-3', value: '3' } }),
    ]
    await handleEventsWriteRequest(await makeRequest(events, token), makeEnv(db))
    const tables = (await snapshot())
    expect(tables.events).toHaveLength(3)
    const seqs = tables.events.map((e: any) => e.server_seq).sort((a: number, b: number) => a - b)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('two concurrent /events requests for the same project produce strictly distinct seqs', async () => {
    // server_seq is now derived inside each events INSERT via a correlated
    // subquery, so within a single batch each statement picks the next seq
    // from the just-inserted prior row, and concurrent batches serialise at
    // the database primary. The pre-fix code read MAX once per request in JS and
    // pre-computed seqs, which collided on the UNIQUE INDEX
    // idx_events_project_seq under concurrency.
    //
    // The in-memory fake cannot deterministically interleave two route
    // handlers across microtasks the way real Postgres interleaves HTTP requests,
    // so this test mostly documents the contract; the fake additionally
    // enforces the UNIQUE constraint, so any code path that produces a
    // duplicate (project_id, server_seq) trips loudly.
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    const batchA = [
      targetCreate({ id: 'a1', cellId: 'cell-a1', payload: { cellId: 'cell-a1', value: 'a1' } }),
      targetCreate({ id: 'a2', cellId: 'cell-a2', payload: { cellId: 'cell-a2', value: 'a2' } }),
    ]
    const batchB = [
      targetCreate({ id: 'b1', cellId: 'cell-b1', payload: { cellId: 'cell-b1', value: 'b1' } }),
      targetCreate({ id: 'b2', cellId: 'cell-b2', payload: { cellId: 'cell-b2', value: 'b2' } }),
    ]

    await Promise.all([
      handleEventsWriteRequest(await makeRequest(batchA, token), makeEnv(db)),
      handleEventsWriteRequest(await makeRequest(batchB, token), makeEnv(db)),
    ])

    const tables = (await snapshot())
    expect(tables.events).toHaveLength(4)
    const seqs = tables.events.map((e: any) => e.server_seq).sort((a: number, b: number) => a - b)
    expect(new Set(seqs).size).toBe(4)
    expect(seqs).toEqual([1, 2, 3, 4])
  })
})

// ── AD-2 parent-chain rule ─────────────────────────────────────────────

describe('POST /events — AD-2 first-child-of-parent', () => {
  it('cell commits follow first-child-of-parent: a later sibling is logged but does NOT overwrite the projection', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    // Genesis create.
    const create = targetCreate({ id: 'evt-create-001' })
    const r0 = await handleEventsWriteRequest(await makeRequest([create], token), makeEnv(db))
    expect((await r0!.json() as any).accepted).toHaveLength(1)

    // Two commits with the SAME parent_id — the Alice/Bob race from the
    // spec, or the equivalent offline-reconnect scenario where the
    // reconnected client's queued commit flushes long after a concurrent
    // online commit has already projected.
    //
    // Per AD-2 (03-data-model.md): the first commit accepted at this
    // parent_id wins the chain slot; the second is durably logged but
    // does NOT advance the projection. It is reported in `stale` so the
    // client outbox can surface "your edit was bumped" and offer a
    // promote-from-history affordance.
    const first = targetCommit({
      id: 'evt-first',
      parentId: 'evt-create-001',
      payload: { value: 'FIRST' },
    })
    const second = targetCommit({
      id: 'evt-second',
      parentId: 'evt-create-001',
      payload: { value: 'SECOND' },
    })

    const r1 = await handleEventsWriteRequest(await makeRequest([first], token), makeEnv(db))
    expect((await r1!.json() as any).accepted).toHaveLength(1)

    let cell = (await snapshot()).cells[0]
    expect(cell.value).toBe('FIRST')
    expect(cell.event_id).toBe('evt-first')

    // Second commit on the same parent: accepted (200, durable in `events`)
    // but flagged stale and projection is unchanged.
    const r2 = await handleEventsWriteRequest(await makeRequest([second], token), makeEnv(db))
    const body2 = await r2!.json() as any
    expect(body2.accepted).toHaveLength(1)
    expect(body2.rejected).toHaveLength(0)
    expect(body2.stale).toHaveLength(1)
    expect(body2.stale[0].id).toBe('evt-second')

    const events = (await snapshot()).events
    // Both events durably persisted.
    expect(events.find((e: any) => e.id === 'evt-first')).toBeDefined()
    expect(events.find((e: any) => e.id === 'evt-second')).toBeDefined()

    cell = (await snapshot()).cells[0]
    // Projection still pinned to the first-child winner.
    expect(cell.value).toBe('FIRST')
    expect(cell.event_id).toBe('evt-first')
  })

  it('idempotent replay: the same event id replayed twice keeps the same chain head', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    const create = targetCreate({ id: 'evt-create-001' })
    await handleEventsWriteRequest(await makeRequest([create], token), makeEnv(db))
    await handleEventsWriteRequest(await makeRequest([create], token), makeEnv(db))

    const tables = (await snapshot())
    expect(tables.events).toHaveLength(1)
    expect(tables.cells).toHaveLength(1)
    expect(tables.cells[0].event_id).toBe('evt-create-001')
  })
})

// ── AD-9 source pin ────────────────────────────────────────────────────

describe('POST /events — AD-9 source_event_id pin', () => {
  it('target.cell.commit writes payload.sourceEventId into cells.source_event_id', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    const commit = targetCommit({
      id: 'evt-commit-001',
      parentId: 'evt-create-001',
      payload: {
        value: 'translated',
        valueHtml: '<p>translated</p>',
        sourceEventId: 'src-pin-99',
      },
    })
    await handleEventsWriteRequest(await makeRequest([commit], token), makeEnv(db))

    const cell = (await snapshot()).cells[0]
    expect(cell.source_event_id).toBe('src-pin-99')
  })

  it('target.cell.commit without sourceEventId leaves source_event_id NULL', async () => {
    const token = await makeToken()
    const { db, snapshot } = await makeTestDb()
    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    await handleEventsWriteRequest(
      await makeRequest([targetCommit({ id: 'evt-commit-001' })], token),
      makeEnv(db),
    )
    const cell = (await snapshot()).cells[0]
    expect(cell.source_event_id).toBeNull()
  })
})

// ── Validation ─────────────────────────────────────────────────────────

describe('POST /events — cell.validate', () => {
  it('marks the cell validated when the validator targets the current chain head', async () => {
    const token = await makeToken({ role: 400 })
    const reviewerToken = await makeToken({ role: 300, username: 'reviewer-bob' })
    const { db, snapshot } = await makeTestDb()
    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    await handleEventsWriteRequest(
      await makeRequest([validate({ payload: { editEventId: 'evt-create-001' } })], reviewerToken),
      makeEnv(db),
    )
    const cell = (await snapshot()).cells[0]
    expect(cell.validated).toBe(1)
  })

  it('validation for a prior edit does NOT mark the cell validated after a new commit', async () => {
    const token = await makeToken({ role: 400 })
    const reviewerToken = await makeToken({ role: 300, username: 'reviewer-bob' })
    const { db, snapshot } = await makeTestDb()

    await handleEventsWriteRequest(
      await makeRequest([targetCreate({ id: 'evt-create-001' })], token),
      makeEnv(db),
    )
    // Validate the create event.
    await handleEventsWriteRequest(
      await makeRequest([validate({ payload: { editEventId: 'evt-create-001' } })], reviewerToken),
      makeEnv(db),
    )
    expect((await snapshot()).cells[0].validated).toBe(1)

    // A new commit advances the chain head — validated should flip to 0.
    await handleEventsWriteRequest(
      await makeRequest([targetCommit({ id: 'evt-commit-new', parentId: 'evt-create-001' })], token),
      makeEnv(db),
    )
    expect((await snapshot()).cells[0].validated).toBe(0)
  })
})

// ── ProjectSync fan-out ────────────────────────────────────────────────

describe('POST /events — ProjectSync event.applied fan-out', () => {
  function makeProjectSyncEnv(db: AquillaDb) {
    const bodies: Array<Record<string, unknown>> = []
    const stubFetch = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const env = {
      ...makeEnv(db),
      ProjectSync: {
        idFromName: vi.fn().mockReturnValue({ id: 'do-id' }),
        get: vi.fn().mockReturnValue({ fetch: stubFetch }),
      } as unknown as DurableObjectNamespace,
    }
    return { env, bodies }
  }

  it('stamps the authenticated username into event.applied as `by` (not the client-supplied author)', async () => {
    // The client suppresses the "changed elsewhere" banner when
    // `by === currentUsername`. `by` must come from the verified JWT claims —
    // trusting the raw event's author field would let a buggy/malicious
    // client spoof someone else's identity to suppress (or trigger) banners.
    const token = await makeToken({ username: 'alice' })
    const { db } = await makeTestDb()
    const { env, bodies } = makeProjectSyncEnv(db)

    const res = await handleEventsWriteRequest(
      await makeRequest([targetCreate({ author: 'mallory' })], token),
      env,
    )
    expect(res?.status).toBe(200)

    const applied = bodies.filter((b) => b.t === 'event.applied')
    expect(applied.length).toBe(1)
    expect(applied[0].cell).toBe('cell-1')
    expect(applied[0].by).toBe('alice')
  })
})
