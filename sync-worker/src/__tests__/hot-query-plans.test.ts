// Plan-shape guards for two prod hot queries (pg_stat_statements, 8.6-day
// window ending 2026-09-04, Neon sweet-paper-88472094):
//
//   1. /migrate/event-ids cursor — 8.3K calls, 393 ms mean, 6 GB temp. On later
//      pages the planner flipped to Bitmap Heap Scan + external-merge Sort.
//      Fix: idx_events_project_seq_id (project_id, server_seq) INCLUDE (id)
//      → ordered Index Only Scan, no heap fetch, no Sort (migration 0085).
//   2. files counter recompute — COUNT(DISTINCT cell_id) sorted every row of
//      a 37K-cell file on disk under work_mem=4MB (4.6 GB temp / 5K calls).
//      Fix: GROUP BY cell_id over cells_pkey → Index Only Scan + Group.
//
// Runs on PGlite (real Postgres planner). Data is tiny, so seqscan is disabled
// and the tables are VACUUMed (visibility map) to make the planner's choice
// between index paths the same one prod makes at 20M rows. What is asserted is
// the SHAPE: which index, index-only, and — the part that produced the temp
// writes — the absence of a Sort node.
//
// No negative control for the old COUNT(DISTINCT cell_id) shape: PG16+ feeds a
// DISTINCT aggregate pre-sorted when the chosen index already orders cell_id,
// and on PGlite's one-page table that is cells_pkey, so the old shape is
// Sort-free here. Prod picked the narrower idx_cells_validated (unordered on
// cell_id) and paid an external-merge Sort — GROUP BY pins the ordered path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { fileCountersRecomputeStmt } from '../events/event-projection'

const PROJECT = 'proj-plan'
const FILE = 'file-plan'

async function explain(t: TestDb, sql: string): Promise<string> {
  const r = await t.pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`)
  return r.rows.map((x) => x['QUERY PLAN']).join('\n')
}

describe('hot query plan shapes (PGlite)', () => {
  let t: TestDb

  beforeAll(async () => {
    t = await makeTestDb()
    for (let i = 1; i <= 200; i++) {
      await t.pg.query(
        `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq)
         VALUES ($1, 1, $2, $3, $4, 'target.cell.commit', 'u', '{}', $5, $5, $5)`,
        [`ev-${i}`, PROJECT, FILE, `cell-${i % 50}`, i],
      )
      await t.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at, word_count)
         VALUES ($1, $2, $3, $4, '', 'word', $5, $6, 1)`,
        [PROJECT, FILE, `cell-${i}`, i % 2 ? 'source' : 'target', `ev-${i}`, i],
      )
    }
    // exec() wraps multi-statement strings in a transaction; VACUUM must run
    // as its own top-level statement.
    await t.pg.query('VACUUM ANALYZE events')
    await t.pg.query('VACUUM ANALYZE cells')
    // 200 rows fit in one page, so seqscan/bitmap/hashagg all look free to
    // the planner. Disable them so it has to choose between the ORDERED index
    // paths — the choice prod's planner faces at 20M rows — and a Sort node
    // can only appear when the query shape forces one.
    await t.pg.query('SET enable_seqscan = off')
    await t.pg.query('SET enable_bitmapscan = off')
    await t.pg.query('SET enable_hashagg = off')
  }, 120_000)

  afterAll(async () => {
    await t?.close()
  })

  it('event-ids cursor is an ordered Index Only Scan on the covering index, no Sort', async () => {
    const plan = await explain(
      t,
      `SELECT id, server_seq FROM events
        WHERE project_id = '${PROJECT}' AND server_seq > 150
        ORDER BY server_seq ASC LIMIT 50000`,
    )
    expect(plan).toContain('Index Only Scan using idx_events_project_seq_id')
    expect(plan).not.toMatch(/Sort|Bitmap/)
  })

  it('file counters recompute groups cell_id over cells_pkey, no Sort', async () => {
    // Pull the exact statement the projection runs, with its binds inlined,
    // so the test cannot drift from fileCountersRecomputeStmt.
    const stmt = fileCountersRecomputeStmt(t.db, PROJECT, FILE, 123) as unknown as {
      query: string
      args: unknown[]
    }
    let i = 0
    const sql = stmt.query.replace(/\?/g, () => {
      const v = stmt.args[i++]
      return typeof v === 'number' ? String(v) : `'${String(v)}'`
    })
    expect(i).toBe(stmt.args.length)
    const plan = await explain(t, sql)
    expect(plan).toContain('Index Only Scan using cells_pkey')
    expect(plan).toMatch(/Group Key: (\w+\.)?cell_id/)
    expect(plan).not.toContain('Sort')
  })

})
