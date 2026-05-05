// Tests for handleEventsWriteRequest (POST /events).
//
// Uses the shared in-memory D1 fake from __tests__/helpers/d1-fake.ts and
// the JWT signing pattern from authorize.test.ts.

import { describe, it, expect, vi } from 'vitest'

// route.ts now imports broadcast.ts → partyserver (cloudflare: URL).
// Mock partyserver so Node's ESM loader doesn't choke on cloudflare: imports.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeInMemoryD1 } from './helpers/d1-fake'
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

function makeCommitEvent(overrides: Partial<RawEvent<'cell.commit'>> = {}): RawEvent<'cell.commit'> {
  return {
    id: 'evt-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind: 'cell.commit',
    projectId: 'proj-a',
    fileId: 'file-x',
    cellId: 'cell-1',
    author: 'alice',
    payload: { value: 'hello world', valueHtml: '<p>hello world</p>' },
    clientTs: 1000,
    ...overrides,
  }
}

function makeEnv(db?: D1Database, secret: string | undefined = SECRET) {
  return { CODEX_DB: db, SYNC_SECRET_KEY: secret }
}

async function makeRequest(
  events: unknown[],
  token?: string,
  path = '/events',
  method = 'POST',
): Promise<Request> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return new Request(`https://worker${path}`, {
    method,
    headers,
    body: JSON.stringify({ events }),
  })
}

// ── URL matching ──────────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — URL matching', () => {
  it('returns null for non-/events URLs', async () => {
    const req = new Request('https://worker/admin/projects/p1/rebuild-projection', { method: 'POST' })
    const result = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1()))
    expect(result).toBeNull()
  })

  it('returns null for /events/something (exact match only)', async () => {
    const req = new Request('https://worker/events/foo', { method: 'POST' })
    const result = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1()))
    expect(result).toBeNull()
  })

  it('returns null for the root path', async () => {
    const req = new Request('https://worker/', { method: 'POST' })
    const result = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1()))
    expect(result).toBeNull()
  })
})

// ── Method validation ─────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — method validation', () => {
  it('returns 405 for GET /events', async () => {
    const req = new Request('https://worker/events', { method: 'GET' })
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(405)
  })

  it('returns 405 for DELETE /events', async () => {
    const req = new Request('https://worker/events', { method: 'DELETE' })
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(405)
  })

  it('returns 405 for PUT /events', async () => {
    const req = new Request('https://worker/events', { method: 'PUT' })
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(405)
  })
})

// ── Env validation ────────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — env validation', () => {
  it('returns 500 when SYNC_SECRET_KEY is missing', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })
    // Note: passing undefined explicitly triggers the default-param value, so
    // we must spread the env object directly (same pattern as rebuild.test.ts).
    const res = await handleEventsWriteRequest(req, { CODEX_DB: makeInMemoryD1(), SYNC_SECRET_KEY: undefined }) as Response
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('SYNC_SECRET_KEY')
  })

  it('returns 500 when CODEX_DB is missing', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await handleEventsWriteRequest(req, makeEnv(undefined, SECRET)) as Response
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('CODEX_DB')
  })
})

// ── Body parsing ──────────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — body parsing', () => {
  it('returns 400 for non-JSON body', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'text/plain' },
    })
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(400)
  })

  it('returns 400 when body is missing the "events" key', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST',
      body: JSON.stringify({ notEvents: [] }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(400)
  })

  it('returns 400 when "events" is not an array', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST',
      body: JSON.stringify({ events: 'not an array' }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(400)
  })

  it('returns 400 when "events" is null', async () => {
    const req = new Request('https://worker/events', {
      method: 'POST',
      body: JSON.stringify({ events: null }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(400)
  })
})

// ── Empty batch ───────────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — empty batch', () => {
  it('returns 200 with { accepted: [], rejected: [] } for empty events array', async () => {
    const token = await makeToken()
    const req = await makeRequest([], token)
    const res = await handleEventsWriteRequest(req, makeEnv(makeInMemoryD1())) as Response
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.accepted).toEqual([])
    expect(body.rejected).toEqual([])
  })
})

// ── Mixed batch ───────────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — mixed batch', () => {
  it('accepts valid cell.commit + cell.validate, rejects project mismatch (403)', async () => {
    const validToken = await makeToken()

    const validEvent = makeCommitEvent({ id: 'evt-valid-001' })
    const validateEvent: RawEvent<'cell.validate'> = {
      id: 'evt-validate-003',
      schemaVersion: 1,
      kind: 'cell.validate',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'cell-1',
      author: 'alice',
      payload: { editEventId: 'evt-valid-001' },
      clientTs: 2000,
    }

    const badAuthEventMismatch = makeCommitEvent({
      id: 'evt-bad-auth-002',
      projectId: 'proj-other', // token is for proj-a only → 403 from authorize
    })

    const events = [validEvent, badAuthEventMismatch, validateEvent]
    const req = await makeRequest(events, validToken)
    const db = makeInMemoryD1()
    const res = await handleEventsWriteRequest(req, makeEnv(db)) as Response

    expect(res.status).toBe(200)
    const body = await res.json() as any

    expect(body.accepted).toHaveLength(2)
    const acceptedIds = body.accepted.map((a: any) => a.id).sort()
    expect(acceptedIds).toEqual(['evt-validate-003', 'evt-valid-001'].sort())

    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].id).toBe('evt-bad-auth-002')
    expect(body.rejected[0].status).toBe(403)
  })
})

// ── Successful single cell.commit ─────────────────────────────────────────────

describe('handleEventsWriteRequest — successful single cell.commit', () => {
  it('issues D1 batch with events INSERT and cells UPSERT', async () => {
    const token = await makeToken()
    const event = makeCommitEvent({ id: 'evt-single-001' })
    const req = await makeRequest([event], token)
    const db = makeInMemoryD1()
    const res = await handleEventsWriteRequest(req, makeEnv(db)) as Response

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.accepted).toHaveLength(1)
    expect(body.accepted[0].id).toBe('evt-single-001')
    expect(body.rejected).toHaveLength(0)

    // Verify the D1 batch was issued.
    const stmts = (db as any)._issuedStmts() as Array<{ sql: string; args: unknown[] }>
    // Should have issued: 1 events INSERT + 1 cells UPSERT = 2 statements
    expect(stmts.length).toBeGreaterThanOrEqual(2)

    const eventsInsert = stmts.find((s) => /INSERT OR IGNORE INTO events/.test(s.sql))
    expect(eventsInsert).toBeDefined()
    expect(eventsInsert?.args[0]).toBe('evt-single-001')

    const cellsUpsert = stmts.find((s) => /INSERT INTO cells/.test(s.sql))
    expect(cellsUpsert).toBeDefined()
  })

  it('writes the event row and the cell row into the D1 fake tables', async () => {
    const token = await makeToken()
    const event = makeCommitEvent({
      id: 'evt-table-check-001',
      payload: { value: 'written text', valueHtml: '<p>written text</p>' },
    })
    const req = await makeRequest([event], token)
    const db = makeInMemoryD1()
    await handleEventsWriteRequest(req, makeEnv(db)) as Response

    // Check the events table
    const tables = (db as any)._tables()
    expect(tables.events).toHaveLength(1)
    expect(tables.events[0].id).toBe('evt-table-check-001')
    expect(tables.events[0].kind).toBe('cell.commit')
    expect(tables.events[0].author).toBe('alice')

    // Check the cells table
    expect(tables.cells).toHaveLength(1)
    expect(tables.cells[0].cell_id).toBe('cell-1')
    expect(tables.cells[0].content_text).toBe('written text')
  })
})

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — idempotency', () => {
  it('same event ID submitted twice in the same request: both land in accepted (INSERT OR IGNORE means second insert is a no-op)', async () => {
    const token = await makeToken()
    const event = makeCommitEvent({ id: 'evt-dupe-001' })
    // Same event twice in one request
    const req = await makeRequest([event, event], token)
    const db = makeInMemoryD1()
    const res = await handleEventsWriteRequest(req, makeEnv(db)) as Response

    expect(res.status).toBe(200)
    const body = await res.json() as any

    // Both instances are accepted (auth + dispatch both succeed; the INSERT
    // OR IGNORE makes the second write a DB no-op, but the route still reports
    // acceptance since there was no error).
    expect(body.accepted).toHaveLength(2)
    expect(body.accepted.map((a: any) => a.id)).toEqual(['evt-dupe-001', 'evt-dupe-001'])
    expect(body.rejected).toHaveLength(0)

    // The DB should only have one row (second insert was ignored).
    const tables = (db as any)._tables()
    expect(tables.events).toHaveLength(1)
    expect(tables.events[0].id).toBe('evt-dupe-001')
  })

  it('same event ID submitted in a second request: still accepted (INSERT OR IGNORE is idempotent)', async () => {
    const token = await makeToken()
    const event = makeCommitEvent({ id: 'evt-retry-001' })
    const db = makeInMemoryD1()
    const env = makeEnv(db)

    // First request
    const req1 = await makeRequest([event], token)
    const res1 = await handleEventsWriteRequest(req1, env) as Response
    expect(res1.status).toBe(200)

    // Second request with same event
    const req2 = await makeRequest([event], token)
    const res2 = await handleEventsWriteRequest(req2, env) as Response
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as any
    expect(body2.accepted).toHaveLength(1)
    expect(body2.rejected).toHaveLength(0)

    // DB still has only one row
    const tables = (db as any)._tables()
    expect(tables.events).toHaveLength(1)
  })
})

// ── Missing token ─────────────────────────────────────────────────────────────

describe('handleEventsWriteRequest — auth edge cases', () => {
  it('rejects all events when no Authorization header is provided', async () => {
    const event = makeCommitEvent()
    // makeRequest without token omits the Authorization header
    const req = new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [event] }),
    })
    const db = makeInMemoryD1()
    const res = await handleEventsWriteRequest(req, makeEnv(db)) as Response

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.accepted).toHaveLength(0)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(401)
  })
})

// ── Chunked-batch partial-success ─────────────────────────────────────────────
//
// 51 cell.commit events × 2 stmts each = 102 stmts total.
// With D1_BATCH_LIMIT=100 the route splits into two chunks:
//   chunk 1: stmts[0..99]  → covers events 0..49  (50 events, 100 stmts)
//   chunk 2: stmts[100..101] → covers event 50    (1 event,   2 stmts)
//
// When the second batch() call throws, events 0..49 are already committed
// (accepted) and event 50 is not (rejected with status 500).

/**
 * Wrap makeInMemoryD1 so that the Nth call to batch() throws.
 * All previous calls (< N) execute normally against the in-memory tables.
 */
function makeFailingD1(throwOnBatch: number) {
  const base = makeInMemoryD1()
  let callCount = 0
  const original = (base as any).batch.bind(base)

  ;(base as any).batch = async function (stmts: D1PreparedStatement[]) {
    callCount++
    if (callCount === throwOnBatch) {
      throw new Error('D1 batch simulated failure')
    }
    return original(stmts)
  }

  return base
}

describe('handleEventsWriteRequest — chunked-batch partial-success', () => {
  it('50 accepted / 1 rejected when second D1 chunk throws', async () => {
    const token = await makeToken()
    // Build 51 distinct cell.commit events so they produce 102 D1 statements
    // (2 per event: events INSERT + cells UPSERT).
    const events = Array.from({ length: 51 }, (_, i) =>
      makeCommitEvent({
        id: `evt-chunk-${String(i).padStart(3, '0')}`,
        cellId: `cell-${i}`,
      }),
    )
    const req = await makeRequest(events, token)
    // Fail on the second batch() call — the first chunk (stmts 0..99, events
    // 0..49) commits successfully; the second chunk (stmts 100..101, event 50)
    // throws, so event 50 ends up in rejected.
    const db = makeFailingD1(2)
    const res = await handleEventsWriteRequest(req, makeEnv(db)) as Response

    expect(res.status).toBe(200)
    const body = await res.json() as any

    // 50 events fully committed before the failure.
    expect(body.accepted).toHaveLength(50)

    // 1 event failed because its chunk threw.
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].id).toBe('evt-chunk-050')
    expect(body.rejected[0].status).toBe(500)
    expect(body.rejected[0].reason).toMatch(/not committed|D1 batch/i)
  })
})
