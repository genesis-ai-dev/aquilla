// AQU-1965: a chain-mutating event that loses its AD-2 arbitration is logged,
// answered `200 accepted` and reported in `stale[]` — but it left no
// server-side trace, so a cell whose chain keeps rejecting every commit (the
// Marathi BSB cell-23 symptom: the edit always reverts) was invisible until a
// partner reported it. The route now ships that dead-letter to PostHog Logs,
// keyed per cell, with the parent pin that lost and never the cell text.
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { resetStaleSiblingTelemetryForTests } from '../events/stale-sibling-telemetry'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT = 'proj-stale-telemetry'
const FILE = 'file-stale-telemetry'
const CELL = 'cell-23'

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  resetStaleSiblingTelemetryForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(async () => {
  await t?.close()
})

async function post(
  events: unknown[],
  env: Record<string, unknown>,
  pending: Promise<unknown>[],
): Promise<Response> {
  const token = await makeTestToken(SECRET, {
    projectId: PROJECT, fileId: FILE, userId: 1, username: 'atul', role: 700,
  })
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    }),
    env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p) } },
  )
  return res!
}

describe('POST /events reports stale siblings to PostHog Logs', () => {
  it('ships the dropped commit with project/file/cell, kind and the losing parent — no cell text', async () => {
    const posthog = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', posthog)
    const pending: Promise<unknown>[] = []
    const env = {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://eu.i.posthog.com',
    }

    const genesis = await post([{
      id: 'evt-source-1', schemaVersion: 1, kind: 'source.cell.create',
      projectId: PROJECT, fileId: FILE, cellId: CELL, parentId: null, author: 'atul',
      payload: { cellId: CELL, value: 'Source verse', anchorCellId: null },
      clientTs: 1,
    }], env, pending)
    expect(genesis.status).toBe(200)

    // Two target commits chained on the SAME source head: the first takes the
    // chain slot, the second is dead-lettered as a stale sibling.
    const res = await post([
      {
        id: 'evt-target-win', schemaVersion: 1, kind: 'target.cell.commit',
        projectId: PROJECT, fileId: FILE, cellId: CELL, parentId: 'evt-source-1', author: 'atul',
        payload: { cellId: CELL, value: 'winning draft', sourceEventId: 'evt-source-1' },
        clientTs: 2,
      },
      {
        id: 'evt-target-lost', schemaVersion: 1, kind: 'target.cell.commit',
        projectId: PROJECT, fileId: FILE, cellId: CELL, parentId: 'evt-source-1', author: 'atul',
        payload: { cellId: CELL, value: 'ATULS CORRECTION', sourceEventId: 'evt-source-1' },
        clientTs: 3,
      },
    ], env, pending)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stale: Array<{ id: string; fileId: string | null; cellId: string | null }> }
    expect(body.stale).toEqual([{ id: 'evt-target-lost', fileId: FILE, cellId: CELL }])

    await Promise.all(pending)
    const logCalls = posthog.mock.calls.filter(([url]) => String(url).endsWith('/i/v1/logs'))
    expect(logCalls).toHaveLength(1)
    const sent = String((logCalls[0]![1] as RequestInit).body)
    expect(sent).toContain('"events.cell_id"')
    expect(sent).toContain(CELL)
    expect(sent).toContain(FILE)
    expect(sent).toContain(PROJECT)
    expect(sent).toContain('target.cell.commit')
    expect(sent).toContain('"events.stale_parent_id"')
    expect(sent).toContain('evt-source-1')
    expect(sent).toContain('WARN')
    expect(sent).not.toContain('ATULS CORRECTION')
    expect(sent).not.toContain('winning draft')
  })

  it('ships nothing when every commit applies', async () => {
    const posthog = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', posthog)
    const pending: Promise<unknown>[] = []
    const env = {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://eu.i.posthog.com',
    }
    const res = await post([{
      id: 'evt-source-ok', schemaVersion: 1, kind: 'source.cell.create',
      projectId: PROJECT, fileId: FILE, cellId: 'cell-ok', parentId: null, author: 'atul',
      payload: { cellId: 'cell-ok', value: 'Source verse', anchorCellId: null },
      clientTs: 1,
    }], env, pending)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stale: unknown[] }).stale).toEqual([])
    await Promise.all(pending)
    expect(posthog.mock.calls.filter(([url]) => String(url).endsWith('/i/v1/logs'))).toHaveLength(0)
  })
})
