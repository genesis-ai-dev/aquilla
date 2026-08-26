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
import {
  allocateSeqRange,
  buildSettleSeqRangeStmt,
  fetchPendingFloor,
  PENDING_ALLOC_TTL_MS,
} from '../events/event-insert'

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
})
