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
// AQU-135 regression: after the D1→Postgres migration the import path must
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

async function makeCompletionRequest(token: string): Promise<Request> {
  return new Request('https://worker/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      cells: [],
      complete: true,
    }),
  })
}

describe('POST /import — server_seq is race-safe', () => {
  it('defers derived rollups until one idempotent completion request', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const first = await makeImportRequest(token, {
      idPrefix: 'A',
      cellCount: 3,
      includeFile: true,
    })
    const second = await makeImportRequest(token, {
      idPrefix: 'B',
      cellCount: 2,
    })
    expect((await handleBulkImportRequest(first, makeEnv(db)))?.status).toBe(200)
    expect((await handleBulkImportRequest(second, makeEnv(db)))?.status).toBe(200)

    // Data chunks are the hot path: they write events/cells only and perform
    // no growing full-file scans or progress rewrites.
    expect(await rows('file_section_progress')).toHaveLength(0)
    expect((await rows<any>('files'))[0].cell_count).toBe(0)
    const eventCountBeforeCompletion = (await rows('events')).length

    const response = await handleBulkImportRequest(
      await makeCompletionRequest(token),
      makeEnv(db),
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ accepted: 0, fileId: FILE_ID })
    expect(await rows('events')).toHaveLength(eventCountBeforeCompletion)
    expect((await rows<any>('files'))[0].cell_count).toBe(5)
    expect(await rows('file_section_progress')).toHaveLength(1)

    // A dropped response can make the browser retry finalization. Repeating it
    // must not emit events or duplicate/corrupt the derived rows.
    const retry = await handleBulkImportRequest(
      await makeCompletionRequest(token),
      makeEnv(db),
    )
    expect(retry?.status).toBe(200)
    expect(await rows('events')).toHaveLength(eventCountBeforeCompletion)
    expect(await rows('file_section_progress')).toHaveLength(1)
    expect((await rows<any>('files'))[0].cell_count).toBe(5)
  })

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

// AQU-135: after D1→Postgres migration, cells must actually land in the
// projection table, not just the events log. Progress advances past 0% only
// when the server confirms accepted > 0; the response "accepted" count must
// match the actual rows in `cells`. This verifies the full write path on
// PGlite (real Postgres engine) — an SQLite-ism in the SQL would fail here.
describe('POST /import — cells land in Postgres projection (AQU-135)', () => {
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

    // AQU-135 guard: cells must exist in the projection table.
    // On SQLite-ism bugs (e.g. wrong ON CONFLICT syntax, bad placeholders)
    // the DB write fails and this assertion would catch it.
    const cellRows = await rows('cells')
    expect(cellRows).toHaveLength(CELL_COUNT)
    // All cells are source-side with the correct file_id.
    expect(cellRows.every((c: any) => c.side === 'source')).toBe(true)
    expect(cellRows.every((c: any) => c.file_id === FILE_ID)).toBe(true)

    // The explicit completion marker performs the one authoritative rollup
    // after every data chunk has landed.
    const completion = await handleBulkImportRequest(
      await makeCompletionRequest(token),
      makeEnv(db),
    )
    expect(completion?.status).toBe(200)

    // files row must exist with accurate cell_count after finalization.
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
    // Guards that multi-batch imports don't stall at 0% (AQU-135).
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

  it('cells projection carries derived columns (word_count, content_hash) like the dispatcher', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const body = {
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      file: { id: 'f-evt', name: 'GEN.usfm', fileType: 'usfm' },
      cells: [
        {
          id: 'evt-1',
          cellId: 'GEN 1:1',
          value: 'In the beginning God created',
          canonicalRef: 'GEN 1:1',
          type: 'verse',
        },
      ],
    }
    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)

    const cellRows = await rows('cells')
    expect(cellRows).toHaveLength(1)
    expect(cellRows[0]).toMatchObject({
      cell_id: 'GEN 1:1',
      side: 'source',
      value: 'In the beginning God created',
      canonical_ref: 'GEN 1:1',
      type: 'verse',
      event_id: 'evt-1',
      validated: 0,
      word_count: 5,
      // djb2 of the value — must match event-projection.ts contentHash.
      content_hash: cellRows[0].content_hash,
    })
    expect(typeof cellRows[0].content_hash).toBe('string')
    expect((cellRows[0] as any).content_hash).toHaveLength(8)
  })

  it('carries per-cell metadata through the import route into cells.metadata (OBS frame images)', async () => {
    // Regression: the bulk import route builds its own source.cell.create
    // payloads from body.cells. It must forward `metadata` to the projection,
    // or per-row attachments (OBS frame images) silently vanish even though the
    // single-event dispatcher persists them. Found via live OBS import QA.
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const attachments = [
      { type: 'image', url: 'https://cdn.door43.org/obs/jpg/360px/obs-en-01-01.jpg', alt: 'OBS Image' },
    ]
    const body = {
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      file: { id: 'f-obs', name: 'Open Bible Stories', fileType: 'obs' },
      cells: [
        {
          id: 'obs-evt-1',
          cellId: 'OBS 1:1',
          value: 'This is how God made everything in the beginning.',
          canonicalRef: 'OBS 1:1',
          type: 'text',
          metadata: { attachments },
        },
      ],
    }
    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)

    const cellRows = await rows('cells')
    expect(cellRows).toHaveLength(1)
    const meta = cellRows[0].metadata
    // Postgres JSONB may surface as an object or a JSON string depending on driver.
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta
    expect(parsed).toEqual({ attachments })
  })

  it('duplicate cellIds within one chunk dedupe last-wins (multi-row ON CONFLICT safety)', async () => {
    // Postgres rejects a multi-row INSERT … ON CONFLICT DO UPDATE that touches
    // the same row twice; the bulk builder dedupes by cellId keeping the LAST
    // occurrence, matching what sequential per-row upserts produced.
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const body = {
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      file: { id: 'f-evt', name: 'GEN.usfm', fileType: 'usfm' },
      cells: [
        { id: 'evt-a', cellId: 'GEN 1:1', value: 'first version' },
        { id: 'evt-b', cellId: 'GEN 1:1', value: 'second version' },
      ],
    }
    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)

    // Both events land in the log; the cells projection keeps the last write.
    const events = (await rows('events')).filter((e: any) => e.kind === 'source.cell.create')
    expect(events).toHaveLength(2)
    const cellRows = await rows('cells')
    expect(cellRows).toHaveLength(1)
    expect(cellRows[0]).toMatchObject({ cell_id: 'GEN 1:1', value: 'second version', event_id: 'evt-b' })
  })

  it('imports larger than one bulk statement (>1000 rows) keep seqs contiguous', async () => {
    // BULK_ROWS = 1000: 1001 cells + file.create spans two multi-row event
    // INSERTs — guards the seqBase + chunkOffset + rowOffset math.
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const CELL_COUNT = 1001
    const req = await makeImportRequest(token, {
      idPrefix: 'big',
      cellCount: CELL_COUNT,
      includeFile: true,
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)

    const events = await rows('events')
    expect(events).toHaveLength(CELL_COUNT + 1)
    const seqs = events.map((e: any) => Number(e.server_seq)).sort((a: number, b: number) => a - b)
    expect(seqs[0]).toBe(1)
    expect(seqs[seqs.length - 1]).toBe(CELL_COUNT + 1)
    expect(new Set(seqs).size).toBe(CELL_COUNT + 1)

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

// [Pen test] Input validation & injection attacks — bulk import previously
// accepted an unbounded `cells[]` array and unbounded per-field string/JSON
// sizes, letting a single authenticated request fan out into an oversized
// batch write against the shared single-writer DB, or persist arbitrarily
// large blobs into a `cells` row every collaborator re-fetches.
describe('POST /import — request-size and field-type limits', () => {
  it('rejects a cells[] array over the per-request cap', async () => {
    const token = await leadToken()
    const { db } = await makeTestDb()

    const cells = Array.from({ length: 5001 }, (_, i) => ({
      id: `oversize-evt-${i}`,
      cellId: `oversize-cell-${i}`,
      value: 'x',
    }))
    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: PROJECT_ID, fileId: FILE_ID, cells }),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(413)
  })

  it('rejects an oversized rawSource', async () => {
    const token = await leadToken()
    const { db } = await makeTestDb()

    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: { id: 'file-evt-big', name: 'GEN.usfm', fileType: 'usfm' },
        cells: [],
        rawSource: 'x'.repeat(51 * 1024 * 1024),
        rawSourceFormat: 'usfm',
      }),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(413)
  })

  it('rejects a cell.value that is not a string', async () => {
    const token = await leadToken()
    const { db } = await makeTestDb()

    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        cells: [{ id: 'evt-1', cellId: 'cell-1', value: { not: 'a string' } }],
      }),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(400)
  })

  it('rejects an oversized cell.value', async () => {
    const token = await leadToken()
    const { db } = await makeTestDb()

    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        cells: [{ id: 'evt-1', cellId: 'cell-1', value: 'x'.repeat(257 * 1024) }],
      }),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(413)
  })

  it('rejects a non-object cell.metadata', async () => {
    const token = await leadToken()
    const { db } = await makeTestDb()

    const req = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        cells: [{ id: 'evt-1', cellId: 'cell-1', value: 'ok', metadata: ['not', 'an', 'object'] }],
      }),
    })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(400)
  })

  it('still accepts a well-formed request under all limits', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()

    const req = await makeImportRequest(token, { idPrefix: 'ok', cellCount: 3, includeFile: true })
    const res = await handleBulkImportRequest(req, makeEnv(db))
    expect(res?.status).toBe(200)
    expect(await rows('cells')).toHaveLength(3)
  })
})
