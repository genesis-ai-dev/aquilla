// AQU-1611: the cells page fetch and the progress recompute moved off
// `target_lang` onto `lane_id`. `idx_cells_file_scan` is now
// (project_id, file_id, side, lane_id, cell_id). Both statements must still
// be an index lookup — a seq scan of `cells` is the failure this migration
// exists to prevent.
//
// PGlite, seqscan off, tables vacuumed, same shape guard as
// hot-query-plans.test.ts. The page predicate is the one `readPageValues`
// runs (`CELLS_PAGE_LANE_PREDICATE`). The progress statement is
// `fileProgressRecomputeStmt` itself.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { CELLS_PAGE_LANE_PREDICATE } from '../events/cells-read-route'
import { fileProgressRecomputeStmt } from '../events/progress-projection'

const PROJECT = 'proj-lane-plan'
const FILE = 'file-lane-plan'

async function explain(t: TestDb, sql: string): Promise<string> {
  const r = await t.pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`)
  return r.rows.map((x) => x['QUERY PLAN']).join('\n')
}

function inlineBinds(query: string, args: unknown[]): string {
  let i = 0
  const sql = query.replace(/\?/g, () => {
    const v = args[i++]
    if (typeof v === 'number') return String(v)
    return `'${String(v).replace(/'/g, "''")}'`
  })
  if (i !== args.length) throw new Error(`bind count ${args.length} but ${i} placeholders`)
  return sql
}

describe('AQU-1611 lane-id reader plans (PGlite)', () => {
  let t: TestDb
  let laneId: string

  beforeAll(async () => {
    t = await makeTestDb()
    for (let i = 1; i <= 40; i++) {
      await t.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count) VALUES ($1, $2, $3, 'source', 'word', $4, $5, 1)`,
        [PROJECT, FILE, `cell-${i}`, `ev-s-${i}`, i],
      )
      await t.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count) VALUES ($1, $2, $3, 'target', 'word', $4, $5, 1)`,
        [PROJECT, FILE, `cell-${i}`, `ev-t-${i}`, i],
      )
    }
    const lane = await t.pg.query<{ lane_id: string }>(
      `SELECT lane_id FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'target' LIMIT 1`,
      [PROJECT, FILE],
    )
    laneId = lane.rows[0].lane_id
    await t.pg.query('VACUUM ANALYZE cells')
    await t.pg.query('VACUUM ANALYZE lanes')
    await t.pg.query('SET enable_seqscan = off')
    await t.pg.query('SET enable_bitmapscan = off')
    await t.pg.query('SET enable_hashjoin = off')
  }, 120_000)

  afterAll(async () => {
    await t?.close()
  })

  it('the cells page fetch uses idx_cells_file_scan', async () => {
    const ids = '{cell-1,cell-2,cell-3}'
    const sql = [
      'SELECT cell_id, side, lane_id FROM cells',
      `WHERE project_id = '${PROJECT}' AND file_id = '${FILE}'`,
      `AND ${CELLS_PAGE_LANE_PREDICATE}`,
    ].join(' ')
    const plan = await explain(t, inlineBinds(sql, ['target', laneId, ids]))
    expect(plan).toContain('idx_cells_file_scan')
    expect(plan).not.toMatch(/Seq Scan on cells/)
  })

  it('the progress recompute looks up target cells through an index', async () => {
    const stmt = fileProgressRecomputeStmt(t.db, PROJECT, FILE, 123) as unknown as {
      query: string
      args: unknown[]
    }
    const plan = await explain(t, inlineBinds(stmt.query, stmt.args))
    expect(plan).toMatch(/Index (?:Only )?Scan using (?:idx_cells_file_scan|cells_pkey)/)
    expect(plan).not.toMatch(/Seq Scan on cells/)
  })
})
