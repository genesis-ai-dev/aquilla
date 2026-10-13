// A DB batch failure on POST /events answers 200 with per-event
// `{status: 500, reason: "DB batch failed"}` — which the index.ts wrapper (it
// ships status >= 400 only) never reported. The route now reports it itself:
// project, kind, counts and the pg code/table/column, never cell text.
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { resetRejectionTelemetryForTests } from '../events/rejection-telemetry'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { AquillaDb } from '../../../db/shim/postgres'

const SECRET = 'test-secret'
const PROJECT = 'proj-telemetry'
const FILE = 'file-telemetry'

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  resetRejectionTelemetryForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(async () => {
  await t?.close()
})

/** The real database, except every batch fails like the AQU-1900 NOT NULL. */
function failingBatches(db: AquillaDb): AquillaDb {
  const pgError = Object.assign(
    new Error('null value in column "lane_id" of relation "cells" violates not-null constraint'),
    { code: '23502', table: 'cells', column: 'lane_id' },
  )
  const failing = Object.create(db) as AquillaDb & { batchPipelined?: unknown }
  failing.batchPipelined = undefined
  failing.batch = async () => { throw pgError }
  return failing
}

describe('POST /events reports per-event 5xx to PostHog Logs', () => {
  it('ships the DB batch failure with project, kind, counts and the pg column — no cell text', async () => {
    const posthog = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', posthog)
    const pending: Promise<unknown>[] = []
    const token = await makeTestToken(SECRET, {
      projectId: PROJECT, fileId: FILE, userId: 1, username: 'alice', role: 700,
    })
    const res = await handleEventsWriteRequest(
      new Request('https://worker/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          events: [{
            id: 'evt-telemetry-1', schemaVersion: 1, kind: 'source.cell.create',
            projectId: PROJECT, fileId: FILE, cellId: 'cell-1', parentId: null, author: 'alice',
            payload: { cellId: 'cell-1', value: 'PRIVATE SOURCE TEXT', anchorCellId: null },
            clientTs: 1,
          }],
        }),
      }),
      {
        AQUILLA_PG: failingBatches(t.db),
        SYNC_SECRET_KEY: SECRET,
        POSTHOG_KEY: 'phc_test',
        POSTHOG_HOST: 'https://eu.i.posthog.com',
      },
      { waitUntil: (p: Promise<unknown>) => { pending.push(p) } },
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { rejected: Array<{ id: string; status: number; reason: string }> }
    expect(body.rejected).toEqual([{ id: 'evt-telemetry-1', status: 500, reason: 'DB batch failed' }])

    await Promise.all(pending)
    const logCalls = posthog.mock.calls.filter(([url]) => String(url).endsWith('/i/v1/logs'))
    expect(logCalls).toHaveLength(1)
    const sent = String((logCalls[0]![1] as RequestInit).body)
    expect(sent).toContain('"events.project_id"')
    expect(sent).toContain(PROJECT)
    expect(sent).toContain('source.cell.create')
    expect(sent).toContain('DB batch failed')
    expect(sent).toContain('"23502"')
    expect(sent).toContain('lane_id')
    expect(sent).not.toContain('PRIVATE SOURCE TEXT')
    expect(sent).not.toContain('violates not-null constraint')
  })
})
