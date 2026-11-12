// AQU-1611: the progress recomputes join lanes on the BARE `lane_id` column.
//
// `idx_cells_file_scan` is `(project_id, file_id, side, lane_id, cell_id)`
// (migration 0154). `t.lane_id = lanes.lane_id` is an indexable equality on
// that column. Wrapping the join key in COALESCE makes the predicate
// non-indexable, so the planner stops at the `(project_id, file_id, side)`
// prefix and pairs `lanes × source cells` against every target row in the file
// before filtering. On a 10k-cell file that rejected ~4M candidate pairs per
// recompute, while concurrent writers waited on the same rows.
//
// Two guards, because each catches what the other cannot:
//   1. the SQL shape — a COALESCE cannot come back on the join key;
//   2. the RESULTS — the default lane ('') and named lanes still project
//      exactly what they did when the join was the bare tag column.
//
// The source lane's `lane_id` matches no target cell, which is what
// `join_tag` being NULL used to do. The audio join stays on `join_tag`.
import { describe, expect, it } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import { progressRowsForLane } from './helpers/progress-rows'
import {
  fileProgressRecomputeStmt,
  fullProgressRecomputeStmts,
  sectionsProgressRecomputeStmt,
} from '../events/progress-projection'

const PROJECT = 'project-lane-join'
const FILE = 'file-lane-join'

const sqlOf = (s: AquillaStatement): string => (s as unknown as { _sql(): string })._sql()

function source(cellId: string, canonicalRef: string) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'source',
    value: `source ${cellId}`, canonical_ref: canonicalRef, event_id: `source-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0, word_count: 2,
    target_lang: '',
  }
}

function target(cellId: string, lane: string, value: string, endorsements = 0) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'target',
    value, canonical_ref: null, event_id: `target-${lane}-${cellId}`,
    last_editor: 'alice', last_edit_at: 2, validated: 0,
    endorsement_count: endorsements, word_count: value ? 1 : 0,
    target_lang: lane,
  }
}

/** Two lanes over three source cells: '' (the N=1 default) and 'fr'. */
async function fixture() {
  return makeTestDb({
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' }],
    cells: [
      source('c1', 'GEN 1:1'), target('c1', '', 'uno', 2), target('c1', 'fr', 'un'),
      source('c2', 'GEN 1:2'), target('c2', '', ''), target('c2', 'fr', 'deux'),
      source('c3', 'GEN 2:1'), target('c3', '', 'tres'),
    ],
  })
}

interface ProgressRow {
  scope: string
  section_key: string
  target_lang: string
  total_count: number
  filled_count: number
}

/** Target-lane rows only — the source lane's carries no lane's filled count. */
const byLane = (rows: ProgressRow[], scope: string, key: string) =>
  rows
    .filter((r) => r.scope === scope && r.section_key === key)
    .sort((a, b) => a.target_lang.localeCompare(b.target_lang))
    .map((r) => [r.target_lang, r.total_count, r.filled_count])

describe('AQU-1611 — progress lane joins compare the bare lane_id column', () => {
  it('never wraps the join key in COALESCE, in the file, partial or full recompute', async () => {
    const t = await makeTestDb()
    try {
      const statements = [
        fileProgressRecomputeStmt(t.db, PROJECT, FILE, 1),
        sectionsProgressRecomputeStmt(t.db, PROJECT, FILE, 1),
        sectionsProgressRecomputeStmt(t.db, PROJECT, FILE, 1, ['c1']),
        ...fullProgressRecomputeStmts(t.db, PROJECT, FILE, 1),
      ].map(sqlOf)

      // The two progress recomputes that carry the lane join must spell it bare.
      const withLaneJoin = statements.filter((sql) => sql.includes('lanes.join_tag'))
      expect(withLaneJoin.length).toBeGreaterThanOrEqual(3)
      for (const sql of withLaneJoin) {
        expect(sql).toContain('t.lane_id = lanes.lane_id')
        expect(sql).not.toContain('COALESCE(t.lane_id')
        expect(sql).not.toContain('t.target_lang = lanes.join_tag')
      }
    } finally {
      await t.close()
    }
  })

  it('projects the same default-lane and named-lane totals the wrapped comparison did', async () => {
    const t = await fixture()
    try {
      await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, FILE, 100))
      const rows = await progressRowsForLane<ProgressRow>(t.pg, PROJECT, 'target')

      // The denominator is lane-independent (3 source cells); each lane counts
      // only its OWN filled targets. '' has uno + tres; 'fr' has un + deux.
      expect(byLane(rows, 'file', '')).toEqual([
        ['', 3, 2],
        ['fr', 3, 2],
      ])
      expect(byLane(rows, 'section', 'GEN 1')).toEqual([
        ['', 2, 1],
        ['fr', 2, 2],
      ])
      expect(byLane(rows, 'section', 'GEN 2')).toEqual([
        ['', 1, 1],
        ['fr', 1, 0],
      ])
      expect(byLane(rows, 'book', 'GEN')).toEqual([
        ['', 3, 2],
        ['fr', 3, 2],
      ])
    } finally {
      await t.close()
    }
  })

  it('keeps the two lanes apart on an incremental per-cell recompute', async () => {
    const t = await fixture()
    try {
      await t.db.batch(fullProgressRecomputeStmts(t.db, PROJECT, FILE, 100))
      // Fill the default lane's empty c2 — 'fr' already has it and must not move.
      await t.pg.query(
        `UPDATE cells SET value = 'dos' WHERE project_id = $1 AND file_id = $2
           AND cell_id = 'c2' AND side = 'target'
           AND lane_id = (SELECT id FROM lanes WHERE project_id = $1 AND role = 'target' AND legacy_tag = '')`,
        [PROJECT, FILE],
      )
      await t.db.batch([
        fileProgressRecomputeStmt(t.db, PROJECT, FILE, 101),
        sectionsProgressRecomputeStmt(t.db, PROJECT, FILE, 101, ['c2']),
      ])

      const rows = await progressRowsForLane<ProgressRow>(t.pg, PROJECT, 'target')
      expect(byLane(rows, 'file', '')).toEqual([
        ['', 3, 3],
        ['fr', 3, 2],
      ])
      expect(byLane(rows, 'section', 'GEN 1')).toEqual([
        ['', 2, 2],
        ['fr', 2, 2],
      ])
      // The untouched section is untouched, in both lanes.
      expect(byLane(rows, 'section', 'GEN 2')).toEqual([
        ['', 1, 1],
        ['fr', 1, 0],
      ])
    } finally {
      await t.close()
    }
  })
})
