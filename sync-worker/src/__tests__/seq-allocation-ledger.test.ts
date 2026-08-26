// AQU-1005 seq-allocation ledger: allocation announces its range, the write
// batch settles it, readers fence the advertised cursor on the oldest live
// (unsettled, unexpired) allocation. These tests pin the primitives; the
// route-level fence behaviour is tested in Task 6's cases below (same file).
import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
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
