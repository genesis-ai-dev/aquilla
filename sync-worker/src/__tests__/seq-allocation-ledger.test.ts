// AQU-1005 seq-allocation ledger: allocation announces its range, the write
// batch settles it, readers fence the advertised cursor on the oldest live
// (unsettled, unexpired) allocation. These tests pin the primitives; the
// route-level fence behaviour is tested in Task 6's cases below (same file).
import { describe, it, expect, beforeEach, vi } from 'vitest'

// route.ts imports broadcast.ts -> partyserver (cloudflare:* imports).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { handleEventsWriteRequest } from '../events/route'
import { handleBulkImportRequest } from '../events/import-route'
import { handleCellsReadRequest } from '../events/cells-read-route'
import {
  allocateSeqRange,
  buildSettleSeqRangeStmt,
  fetchPendingFloor,
  PENDING_ALLOC_TTL_MS,
} from '../events/event-insert'
import { mirrorSync } from '../events/link-sync'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import type { AquillaStatement } from '../../../db/shim/postgres'

const PROJECT = 'proj-ledger'

describe('seq allocation ledger', () => {
  let t: TestDb
  beforeEach(async () => {
    t = await makeTestDb()
  })

  it('allocateSeqRange announces the range and keeps counter semantics', async () => {
    const base = await allocateSeqRange(t.db, PROJECT, 5)
    expect(base).toBe(1)
    const row = await t.db
      .prepare('SELECT first_seq, last_seq FROM seq_allocations WHERE project_id = ?')
      .bind(PROJECT)
      .first<{ first_seq: number | string; last_seq: number | string }>()
    expect(Number(row?.first_seq)).toBe(1)
    expect(Number(row?.last_seq)).toBe(5)
    // Counter self-heal arms survive: a second allocation continues above.
    const base2 = await allocateSeqRange(t.db, PROJECT, 2)
    expect(base2).toBe(6)
  })

  it('settle removes exactly the allocated range row', async () => {
    const base = await allocateSeqRange(t.db, PROJECT, 3)
    const other = await allocateSeqRange(t.db, PROJECT, 3)
    await buildSettleSeqRangeStmt(t.db, PROJECT, base).run()
    const floors = await t.db
      .prepare('SELECT first_seq FROM seq_allocations WHERE project_id = ? ORDER BY first_seq')
      .bind(PROJECT)
      .all<{ first_seq: number | string }>()
    expect(floors.results.map((r) => Number(r.first_seq))).toEqual([other])
  })

  it('fetchPendingFloor = oldest live allocation minus one; null when clear', async () => {
    expect(await fetchPendingFloor(t.db, PROJECT)).toBeNull()
    const a = await allocateSeqRange(t.db, PROJECT, 4) // 1..4
    const b = await allocateSeqRange(t.db, PROJECT, 4) // 5..8
    expect(await fetchPendingFloor(t.db, PROJECT)).toBe(a - 1) // 0
    await buildSettleSeqRangeStmt(t.db, PROJECT, a).run()
    expect(await fetchPendingFloor(t.db, PROJECT)).toBe(b - 1) // 4
    await buildSettleSeqRangeStmt(t.db, PROJECT, b).run()
    expect(await fetchPendingFloor(t.db, PROJECT)).toBeNull()
  })

  it('expired allocations are ignored by the floor and purged by the next alloc', async () => {
    await allocateSeqRange(t.db, PROJECT, 2) // 1..2, will be aged out
    await t.db
      .prepare(
        `UPDATE seq_allocations SET created_at = now() - (? * interval '1 millisecond')
         WHERE project_id = ?`,
      )
      .bind(PENDING_ALLOC_TTL_MS + 1000, PROJECT)
      .run()
    expect(await fetchPendingFloor(t.db, PROJECT)).toBeNull()
    // Next allocation purges the corpse.
    await allocateSeqRange(t.db, PROJECT, 1)
    const count = await t.db
      .prepare('SELECT COUNT(*)::int AS n FROM seq_allocations WHERE project_id = ?')
      .bind(PROJECT)
      .first<{ n: number }>()
    expect(Number(count?.n)).toBe(1) // only the fresh row
  })
})

// ── Route level (Task 4): POST /events allocates up front and settles ──────

const SECRET = 'test-secret'
const ROUTE_PROJECT = 'proj-route-ledger'
const ROUTE_FILE = 'file-route-ledger'

function routeCommit(id: string, parentId: string | null, value: string) {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: ROUTE_PROJECT,
    fileId: ROUTE_FILE,
    cellId: 'cell-1',
    parentId,
    author: 'alice',
    payload: { value },
    clientTs: 1000,
  }
}

describe('POST /events seq allocation', () => {
  let t: TestDb
  beforeEach(async () => {
    t = await makeTestDb({
      files: [
        {
          id: ROUTE_FILE,
          project_id: ROUTE_PROJECT,
          name: 'Genesis',
          event_id: 'evt-file-genesis',
          meta: '{}',
        },
      ],
    })
  })

  async function post(events: unknown[]): Promise<Response> {
    const token = await makeTestToken(SECRET, {
      projectId: ROUTE_PROJECT,
      fileId: ROUTE_FILE,
      role: 400,
    })
    const req = new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    })
    const res = await handleEventsWriteRequest(req, {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res).not.toBeNull()
    return res!
  }

  async function pendingCount(): Promise<number> {
    const row = await t.db
      .prepare('SELECT COUNT(*)::int AS n FROM seq_allocations WHERE project_id = ?')
      .bind(ROUTE_PROJECT)
      .first<{ n: number }>()
    return Number(row?.n)
  }

  it('settles its allocation when all chunks commit, and writes consecutive explicit seqs', async () => {
    const res = await post([
      routeCommit('evt-r1', null, 'one'),
      routeCommit('evt-r2', 'evt-r1', 'two'),
    ])
    expect(res.status).toBe(200)

    // The ledger fence is released — no writer is still in flight.
    expect(await pendingCount()).toBe(0)

    const seqs = await t.db
      .prepare('SELECT id, server_seq FROM events WHERE project_id = ? ORDER BY server_seq')
      .bind(ROUTE_PROJECT)
      .all<{ id: string; server_seq: number | string }>()
    expect(seqs.results.map((r) => r.id)).toEqual(['evt-r1', 'evt-r2'])
    expect(seqs.results.map((r) => Number(r.server_seq))).toEqual([1, 2])
  })

  it('leaves no live fence across successive requests and keeps seqs monotonic', async () => {
    await post([routeCommit('evt-r1', null, 'one')])
    await post([routeCommit('evt-r2', 'evt-r1', 'two')])
    expect(await pendingCount()).toBe(0)
    expect(await fetchPendingFloor(t.db, ROUTE_PROJECT)).toBeNull()

    const seqs = await t.db
      .prepare('SELECT server_seq FROM events WHERE project_id = ? ORDER BY server_seq')
      .bind(ROUTE_PROJECT)
      .all<{ server_seq: number | string }>()
    expect(seqs.results.map((r) => Number(r.server_seq))).toEqual([1, 2])
  })

  it('a rejected event consumes its seq (harmless gap) but the block still settles', async () => {
    // Second event is unauthorized for this token's file -> rejected before
    // dispatch, so its pre-allocated seq is simply never written.
    const res = await post([
      routeCommit('evt-r1', null, 'one'),
      { ...routeCommit('evt-r2', 'evt-r1', 'two'), fileId: 'other-file' },
    ])
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rejected: Array<{ id: string }> }
    expect(body.rejected.map((r) => r.id)).toEqual(['evt-r2'])
    expect(await pendingCount()).toBe(0)

    const rows = await t.db
      .prepare('SELECT id, server_seq FROM events WHERE project_id = ?')
      .bind(ROUTE_PROJECT)
      .all<{ id: string; server_seq: number | string }>()
    expect(rows.results.length).toBe(1)
    expect(Number(rows.results[0].server_seq)).toBe(1)
    // The counter advanced past the whole allocated block.
    const counter = await t.db
      .prepare('SELECT last_seq FROM project_seq_counters WHERE project_id = ?')
      .bind(ROUTE_PROJECT)
      .first<{ last_seq: number | string }>()
    expect(Number(counter?.last_seq)).toBe(2)
  })

  it('a mixed-project body cannot touch the foreign tenant: no counter, no ledger row (C1)', async () => {
    // The foreign event is FIRST — the attacker's attempt to steer the whole
    // request's allocation at a project the token has no access to.
    const res = await post([
      { ...routeCommit('evt-foreign', null, 'evil'), projectId: 'victim-proj' },
      routeCommit('evt-r1', null, 'one'),
    ])
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accepted: Array<{ id: string }>
      rejected: Array<{ id: string }>
    }
    expect(body.rejected.map((r) => r.id)).toEqual(['evt-foreign'])
    expect(body.accepted.map((a) => a.id)).toEqual(['evt-r1'])

    // The victim tenant is untouched: no counter bump, no fence row.
    const victimCounter = await t.db
      .prepare('SELECT COUNT(*)::int AS n FROM project_seq_counters WHERE project_id = ?')
      .bind('victim-proj')
      .first<{ n: number }>()
    expect(Number(victimCounter?.n)).toBe(0)
    const victimAlloc = await t.db
      .prepare('SELECT COUNT(*)::int AS n FROM seq_allocations WHERE project_id = ?')
      .bind('victim-proj')
      .first<{ n: number }>()
    expect(Number(victimAlloc?.n)).toBe(0)
    const victimEvents = await t.db
      .prepare('SELECT COUNT(*)::int AS n FROM events WHERE project_id = ?')
      .bind('victim-proj')
      .first<{ n: number }>()
    expect(Number(victimEvents?.n)).toBe(0)

    // The accepted event committed with a seq from the TOKEN project's block,
    // and that block settled.
    expect(await pendingCount()).toBe(0)
    const rows = await t.db
      .prepare('SELECT id, server_seq FROM events WHERE project_id = ?')
      .bind(ROUTE_PROJECT)
      .all<{ id: string; server_seq: number | string }>()
    expect(rows.results.map((r) => r.id)).toEqual(['evt-r1'])
    expect(Number(rows.results[0].server_seq)).toBeGreaterThan(0)
  })

  it('a second event naming a different project is rejected, not written (C1)', async () => {
    const res = await post([
      routeCommit('evt-r1', null, 'one'),
      { ...routeCommit('evt-foreign', 'evt-r1', 'evil'), projectId: 'victim-proj' },
    ])
    const body = (await res.json()) as { rejected: Array<{ id: string }> }
    expect(body.rejected.map((r) => r.id)).toEqual(['evt-foreign'])
    const victim = await t.db
      .prepare('SELECT COUNT(*)::int AS n FROM project_seq_counters WHERE project_id = ?')
      .bind('victim-proj')
      .first<{ n: number }>()
    expect(Number(victim?.n)).toBe(0)
    expect(await pendingCount()).toBe(0)
  })
})

// ── Task 5: bulk import settles its allocation in-batch ────────────────────

describe('POST /import seq allocation', () => {
  const IMPORT_PROJECT = 'proj-import-ledger'

  it('settles its allocation after a successful bulk import', async () => {
    const t2 = await makeTestDb()
    const token = await makeTestToken(SECRET, {
      projectId: IMPORT_PROJECT,
      fileId: 'file-import-ledger',
      role: 500,
    })
    const importReq = new Request('https://worker/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: IMPORT_PROJECT,
        fileId: 'file-import-ledger',
        file: { id: 'evt-file-genesis', name: 'Genesis' },
        cells: [
          { id: 'evt-src-1', cellId: 'cell-1', value: 'In the beginning' },
          { id: 'evt-src-2', cellId: 'cell-2', value: 'And the earth' },
        ],
      }),
    })
    const importRes = await handleBulkImportRequest(importReq, {
      AQUILLA_PG: t2.db,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(importRes!.status).toBe(200)

    const row = await t2.db
      .prepare('SELECT COUNT(*)::int AS n FROM seq_allocations WHERE project_id = ?')
      .bind(IMPORT_PROJECT)
      .first<{ n: number }>()
    expect(Number(row?.n)).toBe(0)
  })
})

// ── Task 6: the cells-read route fences the ADVERTISED watermark ───────────

const FENCE_PROJECT = 'proj-fence'
const FENCE_FILE = 'file-fence'

interface FenceCellSeed {
  project_id: string
  file_id: string
  cell_id: string
  anchor_cell_id: string | null
  event_id: string
  side: string
  value: string
  value_html: string | null
  type: string | null
  canonical_ref: string | null
  last_editor: string
  last_edit_at: number
  validated: number
  word_count: number
  content_hash: string | null
  source_event_id: string | null
}

function fenceCell(cellId: string, anchor: string | null, eventId: string): FenceCellSeed {
  return {
    project_id: FENCE_PROJECT,
    file_id: FENCE_FILE,
    cell_id: cellId,
    anchor_cell_id: anchor,
    event_id: eventId,
    side: 'target',
    value: cellId,
    value_html: null,
    type: null,
    canonical_ref: null,
    last_editor: 'alice',
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    source_event_id: null,
  }
}

function fenceEvent(id: string, seq: number, cellId: string | null) {
  return {
    id,
    schema_version: 1,
    project_id: FENCE_PROJECT,
    file_id: FENCE_FILE,
    cell_id: cellId,
    kind: 'target.cell.commit',
    author: 'alice',
    payload: '{}',
    client_ts: 1700000000000,
    server_ts: 1700000000000,
    server_seq: seq,
  }
}

/** Three settled events at seqs 1..3 over three cells. */
async function makeFenceDb(): Promise<TestDb> {
  return makeTestDb({
    cells: [
      fenceCell('c1', null, 'e1'),
      fenceCell('c2', 'c1', 'e2'),
      fenceCell('c3', 'c2', 'e3'),
    ],
    events: [
      fenceEvent('e1', 1, 'c1'),
      fenceEvent('e2', 2, 'c2'),
      fenceEvent('e3', 3, 'c3'),
    ],
  })
}

async function getCells(t: TestDb, query: string): Promise<Response> {
  const token = await makeTestToken(SECRET, { projectId: FENCE_PROJECT, fileId: FENCE_FILE })
  const req = new Request(
    `https://w/api/v1/projects/${FENCE_PROJECT}/files/${FENCE_FILE}/cells${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const res = await handleCellsReadRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  return res!
}

async function plantAllocation(t: TestDb, first: number, last: number, ageMs = 0): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO seq_allocations (project_id, first_seq, last_seq, created_at)
       VALUES (?, ?, ?, now() - (? * interval '1 millisecond'))`,
    )
    .bind(FENCE_PROJECT, first, last, ageMs)
    .run()
}

describe('cells-read pending-allocation fence', () => {
  it('advertised maxServerSeq is clamped below a live allocation, rows still delivered', async () => {
    const t3 = await makeFenceDb()
    // An in-flight writer holds the block 3..5 and has committed only seq 3 so
    // far. A client that took cursor 3 would never see seqs 4..5.
    await plantAllocation(t3, 3, 5)
    const res = await getCells(t3, '?side=target')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { maxServerSeq: number; cells: Array<{ cellId: string }> }
    expect(body.maxServerSeq).toBe(2)
    // Delivery is NOT clamped — every visible row still ships.
    expect(body.cells.map((c) => c.cellId)).toEqual(['c1', 'c2', 'c3'])
    // The ETag stays on the raw maxSeq so the straggler's commit busts the 304.
    expect(res.headers.get('ETag')).toBe(`"${FENCE_FILE}:0:0:3"`)
  })

  it('a cursor above a freshly clamped watermark does not force resync', async () => {
    const t3 = await makeFenceDb()
    // The client legitimately holds cursor 3 from an earlier response; a
    // writer then announced 3..4 (pendingFloor = 2, below the cursor). That is
    // not incarnation drift — the gate compares against the unclamped max.
    await plantAllocation(t3, 3, 4)
    const res = await getCells(t3, '?since=3')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      delta?: boolean
      resync?: boolean
      maxServerSeq: number
      changedCellIds?: string[]
    }
    expect(body.resync).toBeUndefined()
    expect(body.delta).toBe(true)
    expect(body.changedCellIds).toEqual([])
    expect(body.maxServerSeq).toBe(2)
  })

  it('expired allocations do not clamp', async () => {
    const t3 = await makeFenceDb()
    await plantAllocation(t3, 3, 5, PENDING_ALLOC_TTL_MS + 1000)
    const res = await getCells(t3, '?side=target')
    const body = (await res.json()) as { maxServerSeq: number; cells: unknown[] }
    expect(body.maxServerSeq).toBe(3)
    expect(body.cells.length).toBe(3)
  })
})

// ── Task 6 review fix: the rebuild gate must not loop under a clamp ────────

describe('cells-read rebuild gate under a pending-allocation clamp', () => {
  /** rebuiltSeq = 10 with a live allocation from before the rebuild whose
   *  first_seq is 4 — the pending floor (3) sits BELOW the rebuild marker. */
  async function makeRebuiltFenceDb(expired: boolean): Promise<TestDb> {
    const t3 = await makeFenceDb()
    await t3.db
      .prepare(
        'INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq, project_epoch) VALUES (?, 10, 10, 0)',
      )
      .bind(FENCE_PROJECT)
      .run()
    if (!expired) await plantAllocation(t3, 4, 6)
    return t3
  }

  it('a cursor at the clamped advertisement gets a normal delta, not a resync loop', async () => {
    const t3 = await makeRebuiltFenceDb(false)
    const res = await getCells(t3, '?since=3')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      delta?: boolean
      resync?: boolean
      maxServerSeq: number
    }
    // Without the advertisement fence this would be {resync:true} for every
    // client on every poll until the allocation settled.
    expect(body.resync).toBeUndefined()
    expect(body.delta).toBe(true)
    expect(body.maxServerSeq).toBe(3)
  })

  it('once the allocation is gone the same cursor resyncs exactly once', async () => {
    const t3 = await makeRebuiltFenceDb(true)
    const res = await getCells(t3, '?since=3')
    const body = (await res.json()) as { resync?: boolean; maxServerSeq: number }
    expect(body.resync).toBe(true)
    // The resync hands back a cursor at/above rebuiltSeq, so the client's next
    // delta passes the gate instead of looping.
    expect(body.maxServerSeq).toBeGreaterThanOrEqual(10)
  })
})

// ── Task 7: link-sync fold head is fenced on the UPSTREAM pending floor ────

describe('mirrorSync fold head fenced on upstream pending allocation', () => {
  const LS_UPSTREAM = 'proj-ls-upstream'
  const LS_DOWNSTREAM = 'proj-ls-downstream'
  const LS_FILE = 'file-ls-gen'

  async function seedUpstream(t: TestDb): Promise<void> {
    await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [LS_UPSTREAM])
  }

  async function seedDownstream(t: TestDb): Promise<void> {
    await t.pg.query(
      `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
       VALUES ($1, 'Downstream', 1, $2, 'live', 'source', 0)`,
      [LS_DOWNSTREAM, LS_UPSTREAM],
    )
  }

  let lsSeq = 0
  /** Commit an upstream event at an EXPLICIT server_seq — lets the test place
   *  a settled event ABOVE an unsettled allocation's range, the exact
   *  interleaving that produces a gap if the fold head isn't fenced. */
  async function emitUpstreamCellAtSeq(t: TestDb, cellId: string, seq: number): Promise<void> {
    lsSeq += 1
    const id = `evt-ls-${lsSeq}`
    const payload = { cellId, value: `value-${cellId}`, anchorCellId: null }
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ($1, 1, $2, $3, $4, NULL, 'source.cell.create', 'importer', $5, 1, 1, $6)`,
      [id, LS_UPSTREAM, LS_FILE, cellId, JSON.stringify(payload), seq],
    )
    const event: PersistedEvent = {
      id,
      schemaVersion: 1,
      projectId: LS_UPSTREAM,
      fileId: LS_FILE,
      cellId,
      parentId: null,
      kind: 'source.cell.create',
      author: 'importer',
      payload,
      clientTs: 1,
      serverTs: 1,
      serverSeq: seq,
    }
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(t.db, event, stmts)
    await t.db.batch(stmts)
  }

  async function seedUpstreamFile(t: TestDb): Promise<void> {
    await t.pg.query(
      `INSERT INTO files (id, project_id, name, event_id, meta) VALUES ($1, $2, 'Genesis', 'evt-file-ls', '{}')`,
      [LS_FILE, LS_UPSTREAM],
    )
  }

  async function getCursor(t: TestDb): Promise<number> {
    const row = await t.pg.query<{ source_link_cursor: string }>(
      `SELECT source_link_cursor FROM projects WHERE id = $1`,
      [LS_DOWNSTREAM],
    )
    return Number(row.rows[0]?.source_link_cursor ?? 0)
  }

  it('does not advance the cursor past an in-flight upstream allocation, and picks it up once settled', async () => {
    const t = await makeTestDb()
    try {
      await seedUpstream(t)
      await seedDownstream(t)
      await seedUpstreamFile(t)

      // cell-1 settles at seq 1.
      await emitUpstreamCellAtSeq(t, 'cell-1', 1)

      // A straggler writer pre-allocates seqs 2..3 but has not committed its
      // events yet — the row stays live (unsettled).
      await t.db
        .prepare(
          `INSERT INTO seq_allocations (project_id, first_seq, last_seq, created_at)
           VALUES (?, 2, 3, now())`,
        )
        .bind(LS_UPSTREAM)
        .run()

      // A second, faster writer races ahead and settles cell-2 at seq 4 —
      // MAX(server_seq) (the unfenced head) is now 4, two above the
      // straggler's still-pending first_seq (2).
      await emitUpstreamCellAtSeq(t, 'cell-2', 4)

      const result = await mirrorSync(t.db, LS_DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      // Both already-committed cells get folded/mirrored this run (loadDelta
      // has no upper bound — everything above the OLD cursor is delivered).
      // The bug is what the STORED CURSOR becomes: unclamped, it would jump
      // to the raw head (4), and the next delta query (`server_seq > cursor`)
      // would then permanently skip the straggler's seqs 2..3 once it
      // finally commits. The clamp must stop the cursor at the pending floor
      // (first_seq - 1 = 1) instead.
      expect(result.cellsMirrored).toBe(2)
      expect(await getCursor(t)).toBe(1)

      // A second run while the straggler is still pending is a no-op — the
      // clamped head (1) is not greater than the cursor (1).
      const result2 = await mirrorSync(t.db, LS_DOWNSTREAM)
      expect(result2.ranSync).toBe(false)

      // The straggler settles and commits its events for real.
      await t.db
        .prepare('DELETE FROM seq_allocations WHERE project_id = ? AND first_seq = ?')
        .bind(LS_UPSTREAM, 2)
        .run()
      await emitUpstreamCellAtSeq(t, 'cell-3', 2)
      await emitUpstreamCellAtSeq(t, 'cell-4', 3)

      // No allocation pending any more — the fold can safely reach the real
      // head (4): cell-3 and cell-4 are newly mirrored (cell-2's content is
      // unchanged from the first run, so it hash-suppresses).
      const result3 = await mirrorSync(t.db, LS_DOWNSTREAM)
      expect(result3.ranSync).toBe(true)
      expect(result3.cellsMirrored).toBe(2)
      expect(await getCursor(t)).toBe(4)
    } finally {
      await t.close()
    }
  })
})
