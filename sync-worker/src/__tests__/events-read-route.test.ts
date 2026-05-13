// Tests for handleEventsReadRequest (GET /events).
//
// Uses the shared in-memory D1 fake and the JWT signing helper.

import { describe, it, expect } from 'vitest'
import { handleEventsReadRequest } from '../events/read-route'
import { makeInMemoryD1 } from './helpers/d1-fake'
import { makeTestToken } from './helpers/auth'
import type { EventRow } from './helpers/d1-fake'

const SECRET = 'test-secret'

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-a',
    fileId: 'file-x',
    ...overrides,
  } as any)
}

function makeEventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'evt-001',
    schema_version: 1,
    project_id: 'proj-a',
    file_id: 'file-x',
    cell_id: 'cell-1',
    kind: 'cell.commit',
    author: 'alice',
    payload: JSON.stringify({ value: 'hello' }),
    client_ts: 1000,
    server_ts: 2000,
    ...overrides,
  }
}

function makeEnv(db?: D1Database, secret: string | undefined = SECRET) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: secret }
}

async function makeRequest(
  params: Record<string, string | undefined>,
  token?: string,
  path = '/events',
  method = 'GET',
): Promise<Request> {
  const url = new URL(`http://localhost${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v)
  }
  const headers: Record<string, string> = {}
  if (token !== undefined) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return new Request(url.toString(), { method, headers })
}

describe('handleEventsReadRequest', () => {
  // ── Path / method matching ────────────────────────────────────────────────

  it('returns null for non-/events URL', async () => {
    const req = await makeRequest({}, undefined, '/other')
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res).toBeNull()
  })

  it('returns null for non-GET method on /events (POST passes through to write handler)', async () => {
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token, '/events', 'POST')
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res).toBeNull()
  })

  it('returns null for DELETE method on /events', async () => {
    const req = await makeRequest({ fileId: 'file-x' }, undefined, '/events', 'DELETE')
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res).toBeNull()
  })

  // ── Env / auth guard ─────────────────────────────────────────────────────

  it('returns 500 when SYNC_SECRET_KEY missing', async () => {
    const req = await makeRequest({ fileId: 'file-x' }, 'tok', '/events', 'GET')
    // Pass env without SYNC_SECRET_KEY (explicit undefined triggers the default,
    // so we build the object directly).
    const res = await handleEventsReadRequest(req, { AQUILLA_DB: makeInMemoryD1(), SYNC_SECRET_KEY: undefined })
    expect(res?.status).toBe(500)
  })

  it('returns 500 when AQUILLA_DB missing', async () => {
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(undefined, SECRET))
    expect(res?.status).toBe(500)
  })

  it('returns 401 when Authorization header is missing', async () => {
    const req = await makeRequest({ fileId: 'file-x' })  // no token
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res?.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    const req = await makeRequest({ fileId: 'file-x' }, 'not-a-jwt')
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res?.status).toBe(401)
  })

  // ── Query param validation ────────────────────────────────────────────────

  it('returns 400 when fileId is missing', async () => {
    const token = await makeToken()
    const req = await makeRequest({}, token)  // no fileId
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res?.status).toBe(400)
    const text = await res?.text()
    expect(text).toContain('fileId')
  })

  it('returns 400 when before is not a valid integer', async () => {
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x', before: 'notanumber' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res?.status).toBe(400)
  })

  it('clamps limit=0 to 1', async () => {
    const db = makeInMemoryD1({ events: [makeEventRow()] })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x', limit: '0' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)
    const body = await res?.json() as { events: unknown[] }
    // Limit clamped to 1, so at most 1 event returned.
    expect(body.events.length).toBeLessThanOrEqual(1)
  })

  it('clamps limit=500 to 200', async () => {
    // Create 201 events.
    const events: EventRow[] = Array.from({ length: 201 }, (_, i) =>
      makeEventRow({ id: `evt-${i.toString().padStart(3, '0')}`, server_ts: i + 1 })
    )
    const db = makeInMemoryD1({ events })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x', limit: '500' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)
    const body = await res?.json() as { events: unknown[] }
    expect(body.events.length).toBe(200)
  })

  // ── Auth / scope ─────────────────────────────────────────────────────────

  it('returns 403 for token scoped to a different fileId', async () => {
    const token = await makeToken({ fileId: 'file-other' })
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(makeInMemoryD1()))
    expect(res?.status).toBe(403)
  })

  // ── Happy path ───────────────────────────────────────────────────────────

  it('returns 200 with empty array when no events for fileId', async () => {
    const db = makeInMemoryD1()
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)
    const body = await res?.json() as { events: unknown[] }
    expect(body.events).toEqual([])
  })

  it('returns events ordered by server_ts DESC', async () => {
    const db = makeInMemoryD1({
      events: [
        makeEventRow({ id: 'evt-a', server_ts: 100 }),
        makeEventRow({ id: 'evt-b', server_ts: 300 }),
        makeEventRow({ id: 'evt-c', server_ts: 200 }),
      ],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)
    const body = await res?.json() as { events: Array<{ id: string; serverTs: number }> }
    expect(body.events.map((e) => e.id)).toEqual(['evt-b', 'evt-c', 'evt-a'])
    expect(body.events.map((e) => e.serverTs)).toEqual([300, 200, 100])
  })

  it('scopes results to the token projectId', async () => {
    // Event in a different project should not appear.
    const db = makeInMemoryD1({
      events: [
        makeEventRow({ id: 'evt-mine', project_id: 'proj-a' }),
        makeEventRow({ id: 'evt-other', project_id: 'proj-z' }),
      ],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    const body = await res?.json() as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(['evt-mine'])
  })

  it('filters by cellId when provided', async () => {
    const db = makeInMemoryD1({
      events: [
        makeEventRow({ id: 'evt-1', cell_id: 'cell-1', server_ts: 100 }),
        makeEventRow({ id: 'evt-2', cell_id: 'cell-2', server_ts: 200 }),
        makeEventRow({ id: 'evt-3', cell_id: 'cell-1', server_ts: 300 }),
      ],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x', cellId: 'cell-1' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    const body = await res?.json() as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(['evt-3', 'evt-1'])
  })

  it('filters by before (server_ts < before)', async () => {
    const db = makeInMemoryD1({
      events: [
        makeEventRow({ id: 'evt-old', server_ts: 100 }),
        makeEventRow({ id: 'evt-mid', server_ts: 200 }),
        makeEventRow({ id: 'evt-new', server_ts: 300 }),
      ],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x', before: '250' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    const body = await res?.json() as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(['evt-mid', 'evt-old'])
  })

  it('pagination: limit=2 returns 2 newest events', async () => {
    const db = makeInMemoryD1({
      events: [
        makeEventRow({ id: 'evt-1', server_ts: 100 }),
        makeEventRow({ id: 'evt-2', server_ts: 200 }),
        makeEventRow({ id: 'evt-3', server_ts: 300 }),
      ],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x', limit: '2' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    const body = await res?.json() as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(['evt-3', 'evt-2'])
  })

  it('returns parsed payload object (not raw JSON string)', async () => {
    const payloadObj = { value: 'test content', valueHtml: '<p>test</p>' }
    const db = makeInMemoryD1({
      events: [
        makeEventRow({ payload: JSON.stringify(payloadObj) }),
      ],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    const body = await res?.json() as { events: Array<{ payload: unknown }> }
    expect(body.events[0].payload).toEqual(payloadObj)
  })

  it('maps DB column names to camelCase in response', async () => {
    const db = makeInMemoryD1({
      events: [makeEventRow({ id: 'evt-check', schema_version: 1, client_ts: 111, server_ts: 222 })],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    const body = await res?.json() as { events: Array<Record<string, unknown>> }
    const ev = body.events[0]
    // Should use camelCase keys.
    expect(ev.schemaVersion).toBe(1)
    expect(ev.clientTs).toBe(111)
    expect(ev.serverTs).toBe(222)
    expect(ev.projectId).toBe('proj-a')
    expect(ev.fileId).toBe('file-x')
    expect(ev.cellId).toBe('cell-1')
    // Should NOT have snake_case keys.
    expect(ev.schema_version).toBeUndefined()
    expect(ev.client_ts).toBeUndefined()
    expect(ev.server_ts).toBeUndefined()
  })

  it('returns schemaVersion field in response', async () => {
    const db = makeInMemoryD1({
      events: [makeEventRow({ schema_version: 1 })],
    })
    const token = await makeToken()
    const req = await makeRequest({ fileId: 'file-x' }, token)
    const res = await handleEventsReadRequest(req, makeEnv(db))
    const body = await res?.json() as { events: Array<Record<string, unknown>> }
    expect(body.events[0].schemaVersion).toBe(1)
  })
})
