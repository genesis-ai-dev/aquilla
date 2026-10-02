// AQU-1549: a sibling merge of a LARGE donor has to land.
//
// The fold turns every matched donor translation into one `target.cell.commit`
// event on the host. It used to write all of them with a single multi-row
// INSERT — 12 bound values per event. postgres.js refuses a statement with
// 65,534 or more bound values, so folding a donor with more than 5,461 matched
// cells threw MAX_PARAMETERS_EXCEEDED before a single row was written, and the
// identity route answered 502 with the donor left live. A New Testament alone
// is about 7,900 verses, and the merge tool exists for whole legacy projects.
// This is the defect AQU-1543 fixed in the mirror sync, in its sibling writer.
//
// Two things are pinned, separately, because they fail differently (the same
// split as link-sync-large-upstream.test.ts):
//
//   1. The real thing, at real size: a donor just past the old ceiling folds
//      completely. The test database enforces the driver's ceiling (see
//      DRIVER_MAX_BIND_PARAMS in the helper), so before the fix this died with
//      the exact production error.
//   2. The invariant that makes (1) hold at ANY size: how many values one
//      statement binds does not grow with the donor. Twice the cells means
//      more statements, never bigger ones.
//
// And a third, because bounded statements alone trade a fast failure for a slow
// success: the fold writes two projection statements per cell, so its batches
// go through the pipelined executor when there is one.

import { describe, it, expect } from "vitest"
import { mergeSibling, deterministicMergeEventId } from "../events/merge-sibling-route"
import { EVENT_INSERT_BULK_ROWS } from "../events/event-insert"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb, type TestDbOptions } from "./helpers/pg-test-db"

const HOST = "host-proj-large"
const DONOR = "donor-proj-large"
const HOST_FILE_A = "host-file-matthew"
const HOST_FILE_B = "host-file-mark"
const DONOR_FILE_A = "donor-file-matthew"
const DONOR_FILE_B = "donor-file-mark"
const LANE = "fr"

/** Bound values per row of the canonical events INSERT. */
const EVENT_COLUMNS = 12

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Host', 1), ($2, 'Donor', 1)`, [HOST, DONOR])
  for (const [projectId, fileId] of [
    [HOST, HOST_FILE_A],
    [HOST, HOST_FILE_B],
    [DONOR, DONOR_FILE_A],
    [DONOR, DONOR_FILE_B],
  ]) {
    await t.pg.query(
      `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, $3, $4)`,
      [fileId, projectId, `${fileId}-name`, `${fileId}-evt`],
    )
  }
}

/**
 * `count` cells shared by host and donor under the `book` prefix: the host's
 * source rows in `hostFile`, the donor's default-lane translations of the same
 * cell ids in `donorFile`. Written as the projected `cells` rows the fold
 * reads, set-based — seeding thousands of cells one projection at a time would
 * cost more than the fold under test.
 */
async function seedSharedCells(
  t: TestDb,
  book: string,
  hostFile: string,
  donorFile: string,
  count: number,
): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at)
     SELECT $1, $2, $3::text || '-' || g, 'source', '', 'Verse ' || g, 'hsrc-' || $3::text || '-' || g, 'lead', 1
       FROM generate_series(1, $4::int) g`,
    [HOST, hostFile, book, count],
  )
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at)
     SELECT $1, $2, $3::text || '-' || g, 'target', '', 'Verset ' || g, 'dtgt-' || $3::text || '-' || g, 'translator', 1
       FROM generate_series(1, $4::int) g`,
    [DONOR, donorFile, book, count],
  )
}

/** Donor translations of cells the host does not have — reported as skipped. */
async function seedDonorOnlyCells(t: TestDb, donorFile: string, count: number): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at)
     SELECT $1, $2, 'orphan-' || g, 'target', '', 'Orphelin ' || g, 'dtgt-orphan-' || g, 'translator', 1
       FROM generate_series(1, $3::int) g`,
    [DONOR, donorFile, count],
  )
}

interface LaneFileRow {
  file_id: string
  cells: number
}

async function hostLaneFiles(t: TestDb): Promise<LaneFileRow[]> {
  const r = await t.pg.query<LaneFileRow>(
    `SELECT file_id, COUNT(*)::int AS cells
       FROM cells
      WHERE project_id = $1 AND side = 'target' AND target_lang = $2
      GROUP BY file_id
      ORDER BY file_id`,
    [HOST, LANE],
  )
  return r.rows
}

async function hostEventCount(t: TestDb): Promise<number> {
  const r = await t.pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`, [HOST])
  return r.rows[0]?.n ?? 0
}

/** The most values any one statement carried: the events INSERT, and anything
 *  at all. */
interface StatementSizes {
  eventsInsert: number
  any: number
}

function trackStatementSizes(): { sizes: StatementSizes; opts: TestDbOptions; reset(): void } {
  const sizes: StatementSizes = { eventsInsert: 0, any: 0 }
  return {
    sizes,
    reset: () => {
      sizes.eventsInsert = 0
      sizes.any = 0
    },
    opts: {
      onStatement: (sql, params) => {
        sizes.any = Math.max(sizes.any, params.length)
        if (/INSERT INTO events\b/.test(sql)) {
          sizes.eventsInsert = Math.max(sizes.eventsInsert, params.length)
        }
      },
    },
  }
}

describe("mergeSibling — a donor past what one statement can carry", () => {
  it("folds every matched cell of a 6,000-cell donor onto the host lane", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      // 6,000 matched cells = 6,000 fold events: 72,000 bound values in the
      // old single INSERT, against a ceiling of 65,533.
      await seedSharedCells(t, "mat", HOST_FILE_A, DONOR_FILE_A, 3_500)
      await seedSharedCells(t, "mrk", HOST_FILE_B, DONOR_FILE_B, 2_500)
      await seedDonorOnlyCells(t, DONOR_FILE_B, 3)
      const donorBefore = await t.pg.query(
        `SELECT cell_id, value, event_id FROM cells WHERE project_id = $1 ORDER BY cell_id`,
        [DONOR],
      )

      const result = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: LANE })

      expect(result.merged).toBe(6_000)
      expect(result.lane).toBe(LANE)
      expect(result.skipped.map((s) => s.cellId).sort()).toEqual(["orphan-1", "orphan-2", "orphan-3"])
      // Every translation landed, in the host's file for that cell.
      expect(await hostLaneFiles(t)).toEqual([
        { file_id: HOST_FILE_B, cells: 2_500 },
        { file_id: HOST_FILE_A, cells: 3_500 },
      ])
      // The text is the donor's and the chain is the host's, not just the row
      // count — first and last cell of the larger file, i.e. both ends of the
      // chunked write.
      const ends = await t.pg.query<{ cell_id: string; value: string; event_id: string; source_event_id: string }>(
        `SELECT cell_id, value, event_id, source_event_id FROM cells
          WHERE project_id = $1 AND side = 'target' AND target_lang = $2 AND cell_id IN ('mat-1', 'mat-3500')
          ORDER BY cell_id`,
        [HOST, LANE],
      )
      expect(ends.rows).toEqual([
        {
          cell_id: "mat-1",
          value: "Verset 1",
          event_id: deterministicMergeEventId(HOST, "dtgt-mat-1", LANE),
          source_event_id: "hsrc-mat-1",
        },
        {
          cell_id: "mat-3500",
          value: "Verset 3500",
          event_id: deterministicMergeEventId(HOST, "dtgt-mat-3500", LANE),
          source_event_id: "hsrc-mat-3500",
        },
      ])
      // One event per folded cell, each with its own sequence number.
      expect(await hostEventCount(t)).toBe(6_000)
      const seqs = await t.pg.query<{ n: number }>(
        `SELECT COUNT(DISTINCT server_seq)::int AS n FROM events WHERE project_id = $1`,
        [HOST],
      )
      expect(seqs.rows[0]?.n).toBe(6_000)
      // The sequence reservation was settled with the write, so nothing is left
      // holding the host's readers back.
      const pending = await t.pg.query(`SELECT 1 FROM seq_allocations WHERE project_id = $1`, [HOST])
      expect(pending.rows).toHaveLength(0)
      // The host's default lane and the donor are untouched.
      const hostDefault = await t.pg.query(
        `SELECT 1 FROM cells WHERE project_id = $1 AND side = 'target' AND target_lang = ''`,
        [HOST],
      )
      expect(hostDefault.rows).toHaveLength(0)
      const donorAfter = await t.pg.query(
        `SELECT cell_id, value, event_id FROM cells WHERE project_id = $1 ORDER BY cell_id`,
        [DONOR],
      )
      expect(donorAfter.rows).toEqual(donorBefore.rows)

      // Re-running is still a no-op at this size: same report, no new events.
      const rerun = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: LANE })
      expect(rerun.merged).toBe(6_000)
      expect(await hostEventCount(t)).toBe(6_000)
      expect(await hostLaneFiles(t)).toEqual([
        { file_id: HOST_FILE_B, cells: 2_500 },
        { file_id: HOST_FILE_A, cells: 3_500 },
      ])
    } finally {
      await t.close()
    }
  }, 120_000)
})

describe("mergeSibling — statement size does not grow with the donor", () => {
  /** Fold a `cells`-cell donor; returns the biggest statement the fold sent. */
  async function foldSizes(cells: number): Promise<StatementSizes> {
    const tracker = trackStatementSizes()
    const t = await makeTestDb({}, tracker.opts)
    try {
      await seedProjects(t)
      await seedSharedCells(t, "mat", HOST_FILE_A, DONOR_FILE_A, cells)

      tracker.reset() // measure the fold, not the seeding
      const result = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: LANE })
      expect(result.merged).toBe(cells)
      expect(await hostLaneFiles(t)).toEqual([{ file_id: HOST_FILE_A, cells }])
      return { ...tracker.sizes }
    } finally {
      await t.close()
    }
  }

  it("twice the cells means more statements, not bigger ones", async () => {
    const small = await foldSizes(1_200)
    const large = await foldSizes(2_400)

    expect(large).toEqual(small)
    expect(small.eventsInsert).toBe(EVENT_INSERT_BULK_ROWS * EVENT_COLUMNS)
    // The events INSERT is the fold's only multi-row statement: nothing else it
    // sends is bigger.
    expect(small.any).toBe(small.eventsInsert)
  }, 120_000)
})

describe("mergeSibling — the per-cell writes are pipelined", () => {
  const sqlOf = (s: AquillaStatement): string => (s as unknown as { _sql(): string })._sql()

  /**
   * Wrap the real (PGlite-backed) shim so every batch is recorded with the path
   * it took and the SQL it carried. `batchPipelined` is exposed only when
   * `pipelined` is set, so a test can also model an executor that lacks it.
   */
  function recordingDb(t: TestDb, opts: { pipelined: boolean }) {
    const batches: Array<{ via: "batch" | "batchPipelined"; sql: string[] }> = []
    const db: AquillaDb = {
      prepare: (q) => t.db.prepare(q),
      exec: (q) => t.db.exec(q),
      close: () => t.db.close(),
      batch: async (stmts) => {
        batches.push({ via: "batch", sql: stmts.map(sqlOf) })
        return t.db.batch(stmts)
      },
      ...(opts.pipelined
        ? {
            batchPipelined: async (stmts: AquillaStatement[]) => {
              batches.push({ via: "batchPipelined", sql: stmts.map(sqlOf) })
              return t.db.batchPipelined!(stmts)
            },
          }
        : {}),
    }
    return { db, batches }
  }

  /** The closing per-file recompute — one small batch per touched file, the
   *  only batch that is not part of the fold's per-cell write. */
  const isFileRecompute = (sql: string[]) => sql.some((s) => s.includes("UPDATE files SET cell_count"))

  it("every batch of events and lane rows goes through batchPipelined", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedSharedCells(t, "mat", HOST_FILE_A, DONOR_FILE_A, 250)
      const { db, batches } = recordingDb(t, { pipelined: true })

      const result = await mergeSibling(db, { hostProjectId: HOST, donorProjectId: DONOR, lane: LANE })

      expect(result.merged).toBe(250)
      const writes = batches.filter((b) => !isFileRecompute(b.sql))
      expect(batches.length - writes.length).toBe(1) // one touched file
      // 1 events INSERT + 2 statements per cell + 1 settle, 100 to a batch.
      expect(writes.reduce((n, b) => n + b.sql.length, 0)).toBe(1 + 250 * 2 + 1)
      expect(writes.map((b) => b.via)).toEqual(Array(writes.length).fill("batchPipelined"))
      expect(Math.max(...writes.map((b) => b.sql.length))).toBe(100)
    } finally {
      await t.close()
    }
  })

  it("an executor without batchPipelined still folds everything", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedSharedCells(t, "mat", HOST_FILE_A, DONOR_FILE_A, 250)
      const { db, batches } = recordingDb(t, { pipelined: false })

      const result = await mergeSibling(db, { hostProjectId: HOST, donorProjectId: DONOR, lane: LANE })

      expect(result.merged).toBe(250)
      expect(await hostLaneFiles(t)).toEqual([{ file_id: HOST_FILE_A, cells: 250 }])
      expect(batches.every((b) => b.via === "batch")).toBe(true)
    } finally {
      await t.close()
    }
  })
})
