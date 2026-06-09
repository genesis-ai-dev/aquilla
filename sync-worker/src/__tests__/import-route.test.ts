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
//
// FRO-135 regression: after the D1→Postgres migration the import path must
// actually land cells in the `cells` projection table (not just the events
// table). The DB write-path uses Postgres syntax throughout (ON CONFLICT,
// extract(epoch from now()), $1 placeholders via the shim) — these tests
// run on PGlite (real Postgres engine) to guard against SQLite-ism regressions.

import { describe, it, expect } from 'vitest'

import { handleBulkImportRequest } from '../events/import-route'
import { makeTestDb } from './helpers/pg-test-db'
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

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
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
    const { db, snapshot } = await makeTestDb()

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

    const events = (await snapshot()).events
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
    const { db, snapshot } = await makeTestDb()

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

    const events = (await snapshot()).events
    const seqsAsc = events
      .map((e: any) => e.server_seq)
      .sort((x: number, y: number) => x - y)
    // 4 from A (file.create + 3 cells) + 2 from B = 6 events with seqs 1..6.
    expect(seqsAsc).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('replaying the same import is idempotent and does not bump server_seq', async () => {
    const token = await leadToken()
    const { db, snapshot } = await makeTestDb()

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

    const events = (await snapshot()).events
    // First import: 1 file.create + 2 cells = 3 events.
    // Replay is OR IGNOREd (same UUIDs) — still 3 events with seqs 1..3.
    expect(events).toHaveLength(3)
    const seqsAsc = events
      .map((e: any) => e.server_seq)
      .sort((x: number, y: number) => x - y)
    expect(seqsAsc).toEqual([1, 2, 3])
  })
})

// FRO-135: after D1→Postgres migration, cells must actually land in the
// projection table, not just the events log. Progress advances past 0% only
// when the server confirms accepted > 0; the response "accepted" count must
// match the actual rows in `cells`. This verifies the full write path on
// PGlite (real Postgres engine) — an SQLite-ism in the SQL would fail here.
describe('POST /import — cells land in Postgres projection (FRO-135)', () => {
  it('file.create → files row created; source.cell.create → cells rows created', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const CELL_COUNT = 5
    const req = await makeImportRequest(token, {
      idPrefix: 'bible',
      cellCount: CELL_COUNT,
      includeFile: true,
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)
    const body = await res?.json() as { accepted: number; fileId: string }
    // Server reports accepted = cell count (not counting file.create).
    expect(body.accepted).toBe(CELL_COUNT)

    // FRO-135 guard: cells must exist in the projection table.
    // On SQLite-ism bugs (e.g. wrong ON CONFLICT syntax, bad placeholders)
    // the DB write fails and this assertion would catch it.
    const cellRows = await rows('cells')
    expect(cellRows).toHaveLength(CELL_COUNT)
    // All cells are source-side with the correct file_id.
    expect(cellRows.every((c: any) => c.side === 'source')).toBe(true)
    expect(cellRows.every((c: any) => c.file_id === FILE_ID)).toBe(true)

    // files row must exist with accurate cell_count (deferred recompute runs
    // once at the end of the batch — FRO-135 fix).
    const fileRows = await rows('files')
    expect(fileRows).toHaveLength(1)
    expect(fileRows[0]).toMatchObject({
      id: FILE_ID,
      project_id: PROJECT_ID,
      cell_count: CELL_COUNT,
    })
  })

  it('large import (>BATCH_LIMIT cells) fully lands on Postgres', async () => {
    // BATCH_LIMIT = 100; each cell produces 2 stmts (event + cells INSERT);
    // file.create adds 2 more; the deferred counter recompute adds 1 trailing stmt.
    // A batch of 60 cells = 2 + 120 + 1 = 123 stmts, spanning 2 db.batch() calls.
    // Guards that multi-batch imports don't stall at 0% (FRO-135).
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const CELL_COUNT = 60
    const req = await makeImportRequest(token, {
      idPrefix: 'bulk',
      cellCount: CELL_COUNT,
      includeFile: true,
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)
    const body = await res?.json() as { accepted: number }
    expect(body.accepted).toBe(CELL_COUNT)

    const cellRows = await rows('cells')
    expect(cellRows).toHaveLength(CELL_COUNT)
  })

  it('rawSource side-car lands in file_source_blobs on Postgres', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const rawSource = '\\id GEN\n\\c 1\n\\v 1 In the beginning...'
    const body = {
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      file: { id: 'file-evt-1', name: 'GEN.usfm', fileType: 'usfm' },
      cells: [{ id: 'cell-evt-1', cellId: 'cell-1', value: 'In the beginning...' }],
      rawSource,
      rawSourceFormat: 'usfm',
    }
    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)

    const blobRows = await rows('file_source_blobs')
    expect(blobRows).toHaveLength(1)
    expect(blobRows[0]).toMatchObject({ file_id: FILE_ID, format: 'usfm', raw_source: rawSource })
  })
})
