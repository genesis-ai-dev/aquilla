// Tests for handleBulkImportRequest (POST /import).
//
// Focus: the per-project server_seq assignment is race-safe across concurrent
// requests for the same project. The original implementation read
// MAX(server_seq)+1 in JS before building any INSERT statements, so two
// concurrent imports both saw the same MAX and both tried to insert events
// with the same server_seq — colliding on the UNIQUE INDEX
// idx_events_project_seq and cascading into FK errors on the cells projection
// (cells.event_id REFERENCES events(id), so a silently-IGNOREd events row
// orphans the cells write). Per repro: scripts/usfm-e2e-batch.ts at
// CONCURRENCY=4 failed 56/276; at CONCURRENCY=1 it passed 276/276.

import { describe, it, expect } from 'vitest'

import { handleBulkImportRequest } from '../events/import-route'
import { makeInMemoryD1 } from './helpers/d1-fake'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT_ID = 'proj-race'
const FILE_ID = 'file-race'

async function leadToken(): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: PROJECT_ID,
    fileId: FILE_ID,
    role: 500, // PROJECT_LEAD — import requires lead+
  })
}

function makeEnv(db: D1Database) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

interface ImportRequestOptions {
  /** Distinct prefix so two concurrent batches don't collide on cell ids. */
  idPrefix: string
  cellCount: number
  /** When true, the first chunk also emits a file.create event. */
  includeFile?: boolean
}

async function makeImportRequest(
  token: string,
  opts: ImportRequestOptions,
): Promise<Request> {
  const cells = Array.from({ length: opts.cellCount }, (_, i) => ({
    id: `${opts.idPrefix}-evt-${i}`,
    cellId: `${opts.idPrefix}-cell-${i}`,
    value: `${opts.idPrefix} verse ${i}`,
  }))
  const body: Record<string, unknown> = {
    projectId: PROJECT_ID,
    fileId: FILE_ID,
    cells,
  }
  if (opts.includeFile) {
    body.file = {
      id: `${opts.idPrefix}-file-evt`,
      name: `${opts.idPrefix}.usfm`,
      fileType: 'usfm',
    }
  }
  return new Request('https://worker/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

describe('POST /import — server_seq is race-safe', () => {
  it('two concurrent imports for the same project produce strictly distinct server_seqs', async () => {
    const token = await leadToken()
    const db = makeInMemoryD1()

    const reqA = await makeImportRequest(token, {
      idPrefix: 'A',
      cellCount: 5,
      includeFile: true,
    })
    const reqB = await makeImportRequest(token, {
      idPrefix: 'B',
      cellCount: 5,
    })

    // Fire concurrently. The original bug: both handlers read MAX(server_seq)
    // before either commits, so both compute the same starting seq and write
    // duplicate seqs into the events table.
    const [resA, resB] = await Promise.all([
      handleBulkImportRequest(reqA, makeEnv(db)),
      handleBulkImportRequest(reqB, makeEnv(db)),
    ])

    expect(resA?.status).toBe(200)
    expect(resB?.status).toBe(200)

    const events = (db as any)._tables().events
    // 6 from A (1 file.create + 5 cells) + 5 from B = 11.
    expect(events).toHaveLength(11)

    const projectEvents = events.filter(
      (e: any) => e.project_id === PROJECT_ID,
    )
    expect(projectEvents.length).toBe(11)
    const seqs = projectEvents
      .map((e: any) => e.server_seq)
      .sort((a: number, b: number) => a - b)
    // Force the failure to surface actual seq values during RED phase.
    expect({ seqs, distinct: new Set(seqs).size }).toEqual({
      seqs,
      distinct: seqs.length,
    })
  })

  it('sequential imports keep server_seq monotonically increasing per project', async () => {
    const token = await leadToken()
    const db = makeInMemoryD1()

    const reqA = await makeImportRequest(token, {
      idPrefix: 'A',
      cellCount: 3,
      includeFile: true,
    })
    await handleBulkImportRequest(reqA, makeEnv(db))

    const reqB = await makeImportRequest(token, {
      idPrefix: 'B',
      cellCount: 2,
    })
    await handleBulkImportRequest(reqB, makeEnv(db))

    const events = (db as any)._tables().events
    const seqsAsc = events
      .map((e: any) => e.server_seq)
      .sort((x: number, y: number) => x - y)
    // 4 from A (file.create + 3 cells) + 2 from B = 6 events with seqs 1..6.
    expect(seqsAsc).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('replaying the same import is idempotent and does not bump server_seq', async () => {
    const token = await leadToken()
    const db = makeInMemoryD1()

    const req1 = await makeImportRequest(token, {
      idPrefix: 'X',
      cellCount: 2,
      includeFile: true,
    })
    await handleBulkImportRequest(req1, makeEnv(db))

    // Same body, fresh Request (body streams can't be re-read).
    const req2 = await makeImportRequest(token, {
      idPrefix: 'X',
      cellCount: 2,
      includeFile: true,
    })
    await handleBulkImportRequest(req2, makeEnv(db))

    const events = (db as any)._tables().events
    // First import: 1 file.create + 2 cells = 3 events.
    // Replay is OR IGNOREd (same UUIDs) — still 3 events with seqs 1..3.
    expect(events).toHaveLength(3)
    const seqsAsc = events
      .map((e: any) => e.server_seq)
      .sort((x: number, y: number) => x - y)
    expect(seqsAsc).toEqual([1, 2, 3])
  })
})
