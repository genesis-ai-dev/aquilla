// AQU-1983: resolveSupersedeState reads the live state the supersession
// predicate needs — target values, waived rules, validators — with
// `(file_id, cell_id) IN (…)` lookups over every cell a plan references.
// commit.ts reaches it on the drift branch with ALL of a changeset's target
// cells, 5,000 at the SetTranslation cap, and until this fix each of its three
// reads was ONE statement over the whole list: 10,001 binds and a 5,000-deep
// OR tree, which the PGlite test database cannot parse (AQU-1982) — so no test
// could drive a whole-book changeset through that branch at all. The reads now
// page through lib/cell-key-lookup.ts, like the precondition lookup and
// link-sync's mirror reads.

import { describe, it, expect } from 'vitest'
import { resolveSupersedeState } from '../external/supersede-state'
import { SET_TRANSLATION_MAX_COMMANDS, type Command } from '../external/commands'
import { cellKey, laneCellKey } from '../external/cell-keys'
import { CELL_KEY_LOOKUP_ROWS, selectByCellKeys } from '../lib/cell-key-lookup'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-1983'
const FILE = 'file-1983'
const LANE = 'deflane1'
const ACTOR = 'alice'
const RULE = 'rule-1983'

/** The most values one statement may bind at the current page size: the
 *  project id plus two per cell key. */
const MAX_BINDS_PER_PAGE = 1 + 2 * CELL_KEY_LOOKUP_ROWS

interface Statement {
  sql: string
  binds: number
}

const cellId = (i: number) => `cell-${i}`

/** A project with N target cells, each validated by the actor and carrying one
 *  waived rule — one row per table per cell, so each of the three reads has N
 *  keys to look up. Seeded through PGlite directly (one INSERT … SELECT per
 *  table), so the only statements the shim observes are the reads under test. */
async function seedProject(n: number, statements: Statement[]): Promise<TestDb> {
  const tdb = await makeTestDb(
    { projects: [{ id: PROJECT, name: 'P', created_by: 1, org_id: null }] },
    { onStatement: (sql, params) => statements.push({ sql, binds: params.length }) },
  )
  await tdb.pg.query(
    `INSERT INTO lanes (id, project_id, role, legacy_tag, position) VALUES ($1, $2, 'target', '', 1)`,
    [LANE, PROJECT],
  )
  await tdb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at)
     SELECT $1, $2, 'cell-' || i, 'target', $3, 'translated ' || i, 'evt-' || i, 1
       FROM generate_series(0, $4::int - 1) AS i`,
    [PROJECT, FILE, LANE, n],
  )
  await tdb.pg.query(
    `INSERT INTO cell_validators (project_id, file_id, cell_id, lane_id, event_id, username, decided_ts)
     SELECT $1, $2, 'cell-' || i, $3, 'val-' || i, $4, 1
       FROM generate_series(0, $5::int - 1) AS i`,
    [PROJECT, FILE, LANE, ACTOR, n],
  )
  await tdb.pg.query(
    `INSERT INTO cell_waivers (project_id, file_id, cell_id, rule_id, waived_by, waived_ts)
     SELECT $1, $2, 'cell-' || i, $3, $4, 1
       FROM generate_series(0, $5::int - 1) AS i`,
    [PROJECT, FILE, RULE, ACTOR, n],
  )
  return tdb
}

/** The plan commit re-checks on drift: one SetTranslation per cell, plus one
 *  EmitEvents carrying a cell.validate and a cell.waive per cell — so all
 *  three reads walk N keys. */
function wholeBookPlan(n: number): Command[] {
  const ids = Array.from({ length: n }, (_, i) => cellId(i))
  return [
    ...ids.map(
      (id, i): Command => ({
        kind: 'SetTranslation',
        fileId: FILE,
        cellId: id,
        laneId: LANE,
        value: `translated ${i}`,
      }),
    ),
    {
      kind: 'EmitEvents',
      events: [
        ...ids.map((id) => ({ kind: 'cell.validate', fileId: FILE, cellId: id, laneId: LANE, payload: {} })),
        ...ids.map((id) => ({ kind: 'cell.waive', fileId: FILE, cellId: id, payload: { ruleId: RULE } })),
      ],
    },
  ]
}

describe('AQU-1983 — resolveSupersedeState over a whole-book changeset', () => {
  it('resolves 5,000 target cells in bounded pages, never binding past one page', async () => {
    const n = SET_TRANSLATION_MAX_COMMANDS
    const statements: Statement[] = []
    const tdb = await seedProject(n, statements)

    // Unpaged, the first read rejects here with the AQU-1982 harness
    // diagnostic: "PGlite lost this statement's Parse (10001 binds, …)".
    const live = await resolveSupersedeState(tdb.db, PROJECT, wholeBookPlan(n), ACTOR)

    // (a) The answer is complete: every cell's value, validator and waiver came
    // back, keyed the way the predicate looks them up.
    const missing: string[] = []
    for (let i = 0; i < n; i++) {
      const id = cellId(i)
      if (live.targetValues.get(laneCellKey(FILE, id, LANE))?.value !== `translated ${i}`) missing.push(`value ${id}`)
      if (!live.validators.get(laneCellKey(FILE, id, LANE))?.has(ACTOR)) missing.push(`validator ${id}`)
      if (!live.waivedRules.get(cellKey(FILE, id))?.has(RULE)) missing.push(`waiver ${id}`)
    }
    expect(missing).toEqual([])

    // (b) No statement bound more than one page of keys — 2,001 values at the
    // current page size, against the 10,001 the unpaged read bound.
    expect(MAX_BINDS_PER_PAGE).toBe(2001)
    const worst = Math.max(...statements.map((s) => s.binds))
    expect(worst).toBeLessThanOrEqual(MAX_BINDS_PER_PAGE)

    // …and the reads really were paged rather than merely small: every one of
    // the three walked the whole list, a page at a time.
    const rowIn = statements.filter((s) => s.sql.includes('(file_id, cell_id) IN'))
    expect(rowIn).toHaveLength(3 * Math.ceil(n / CELL_KEY_LOOKUP_ROWS))
  }, 120_000)
})

describe('AQU-1983 — selectByCellKeys', () => {
  it("concatenates every page's rows exactly once, and issues no statement for no keys", async () => {
    const n = 2 * CELL_KEY_LOOKUP_ROWS + 500 // three pages: full, full, partial
    const statements: Statement[] = []
    const tdb = await seedProject(n, statements)
    const keys = Array.from({ length: n }, (_, i) => ({ fileId: FILE, cellId: cellId(i) }))
    const sqlFor = (placeholders: string) =>
      `SELECT cell_id FROM cells WHERE project_id = ? AND (file_id, cell_id) IN (${placeholders})`

    const rows = await selectByCellKeys<{ cell_id: string }>(tdb.db, keys, [PROJECT], sqlFor)
    expect(rows).toHaveLength(n)
    expect(new Set(rows.map((r) => r.cell_id)).size).toBe(n)
    expect(statements.map((s) => s.binds)).toEqual([MAX_BINDS_PER_PAGE, MAX_BINDS_PER_PAGE, 1 + 2 * 500])

    statements.length = 0
    expect(await selectByCellKeys(tdb.db, [], [PROJECT], sqlFor)).toEqual([])
    expect(statements).toHaveLength(0)
  }, 60_000)
})
