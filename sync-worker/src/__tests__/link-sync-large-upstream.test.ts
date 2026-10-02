// AQU-1543: a live link to a LARGE upstream has to seed.
//
// The mirror sync turns one sync window into one event per mirrored file and
// cell. It used to write all of them with a single multi-row INSERT — 12 bound
// values per event — and to look the touched cells up with single
// `(file_id, cell_id) IN (…)` lists. postgres.js refuses a statement with
// 65,534 or more bound values, so the first sync of any upstream past ~5,460
// cells threw MAX_PARAMETERS_EXCEEDED before a single row was written. The
// cursor only advances after a successful write, so every retry replayed the
// same oversized window and failed again: the link was saved, the project read
// as linked, and nothing ever arrived.
//
// Two things are pinned here, separately, because they fail differently:
//
//   1. The real thing, at real size: an upstream just past the old ceiling
//      seeds completely. The test database enforces the driver's ceiling (see
//      DRIVER_MAX_BIND_PARAMS in the helper), so before the fix this died with
//      the exact production error.
//   2. The invariant that makes (1) hold at ANY size: how many values one
//      statement binds does not grow with the upstream. Twice the cells means
//      more statements, never bigger ones. Without this a fix that merely
//      raised the ceiling (chunks of 5,000 rows, say) would pass (1) and still
//      fall over on a whole Bible.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { EVENT_INSERT_BULK_ROWS } from "../events/event-insert"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb, type TestDbOptions } from "./helpers/pg-test-db"

const UPSTREAM = "proj-upstream-large"
const DOWNSTREAM = "proj-downstream-large"
const FILE_A = "file-matthew"
const FILE_B = "file-mark"

/** Bound values per row of the canonical events INSERT. */
const EVENT_COLUMNS = 12

type Consumes = "source" | "target"

async function seedProjects(t: TestDb, consumes: Consumes): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, 'live', $3, 'head', 0)`,
    [DOWNSTREAM, UPSTREAM, consumes],
  )
}

async function nextUpstreamSeq(t: TestDb): Promise<number> {
  const row = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  return Number(row.rows[0]?.next_seq ?? 1)
}

let _id = 0

/** One upstream event through the front-door projection — used for the handful
 *  of events (file creates, individual hides) where the real projection is the
 *  point. The thousands of cells are seeded in bulk below. */
async function emitUpstream(
  t: TestDb,
  kind: "file.create" | "source.cell.visibility.set",
  args: { fileId: string; cellId?: string; payload: Record<string, unknown> },
): Promise<void> {
  _id += 1
  const id = `evt-large-${_id}`
  const seq = await nextUpstreamSeq(t)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'lead', $6, 1, $7, $7)`,
    [id, UPSTREAM, args.fileId, args.cellId ?? null, kind, JSON.stringify(args.payload), seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId,
    cellId: args.cellId ?? null,
    parentId: null,
    kind,
    author: "lead",
    payload: args.payload,
    clientTs: 1,
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

/**
 * `count` source cells for one upstream file, written as the rows the real
 * import leaves behind — a `source.cell.create` event and its projected `cells`
 * row each — but set-based: seeding thousands of cells one projection at a time
 * would cost more than the sync under test.
 */
async function seedSourceCells(t: TestDb, fileId: string, count: number): Promise<void> {
  const base = await nextUpstreamSeq(t)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     SELECT 'evt-src-' || $2::text || '-' || g, 1, $1, $2, 'cell-' || g, NULL, 'source.cell.create', 'lead',
            json_build_object('cellId', 'cell-' || g, 'value', 'Verse ' || g, 'anchorCellId', NULL,
                              'canonicalRef', 'MAT 1:' || g)::text,
            1, $3::bigint + g - 1, $3::bigint + g - 1
       FROM generate_series(1, $4::int) g`,
    [UPSTREAM, fileId, base, count],
  )
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, canonical_ref, event_id, last_editor, last_edit_at)
     SELECT $1, $2, 'cell-' || g, 'source', '', 'Verse ' || g, 'MAT 1:' || g, 'evt-src-' || $2::text || '-' || g, 'lead', 1
       FROM generate_series(1, $3::int) g`,
    [UPSTREAM, fileId, count],
  )
}

/** A committed translation for each of the file's first `count` cells, on the
 *  upstream's default lane — what a `consumes: 'target'` link reads its text
 *  from. Same event-plus-projected-row shape as `seedSourceCells`. */
async function seedTargetCommits(t: TestDb, fileId: string, count: number): Promise<void> {
  const base = await nextUpstreamSeq(t)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     SELECT 'evt-tgt-' || $2::text || '-' || g, 1, $1, $2, 'cell-' || g, NULL, 'target.cell.commit', 'translator',
            json_build_object('value', 'Verset ' || g)::text,
            1, $3::bigint + g - 1, $3::bigint + g - 1
       FROM generate_series(1, $4::int) g`,
    [UPSTREAM, fileId, base, count],
  )
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at)
     SELECT $1, $2, 'cell-' || g, 'target', '', 'Verset ' || g, 'evt-tgt-' || $2::text || '-' || g, 'translator', 1
       FROM generate_series(1, $3::int) g`,
    [UPSTREAM, fileId, count],
  )
}

/** The upstream lead parks every cell of a file, as bare visibility events with
 *  no text change — a window the sync can only resolve by reading the upstream's
 *  live rows back, one lookup key per cell. */
async function hideEveryCell(t: TestDb, fileId: string, count: number): Promise<void> {
  const base = await nextUpstreamSeq(t)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     SELECT 'evt-hide-' || $2::text || '-' || g, 1, $1, $2, 'cell-' || g, NULL, 'source.cell.visibility.set', 'lead',
            '{"hidden":true}', 1, $3::bigint + g - 1, $3::bigint + g - 1
       FROM generate_series(1, $4::int) g`,
    [UPSTREAM, fileId, base, count],
  )
  await t.pg.query(
    `UPDATE cells SET hidden_at = 1 WHERE project_id = $1 AND file_id = $2 AND side = 'source'`,
    [UPSTREAM, fileId],
  )
}

interface DownstreamFileRow {
  file_id: string
  name: string
  cells: number
  hidden: number
}

async function downstreamFiles(t: TestDb): Promise<DownstreamFileRow[]> {
  const r = await t.pg.query<DownstreamFileRow>(
    `SELECT f.id AS file_id, f.name,
            COUNT(c.cell_id)::int AS cells,
            COUNT(c.hidden_at)::int AS hidden
       FROM files f
       LEFT JOIN cells c
         ON c.project_id = f.project_id AND c.file_id = f.id AND c.side = 'source'
      WHERE f.project_id = $1
      GROUP BY f.id, f.name
      ORDER BY f.name`,
    [DOWNSTREAM],
  )
  return r.rows
}

async function downstreamCursor(t: TestDb): Promise<number> {
  const r = await t.pg.query<{ source_link_cursor: string }>(
    `SELECT source_link_cursor FROM projects WHERE id = $1`,
    [DOWNSTREAM],
  )
  return Number(r.rows[0]?.source_link_cursor)
}

async function upstreamHead(t: TestDb): Promise<number> {
  return (await nextUpstreamSeq(t)) - 1
}

/** The most values any one statement of each bind-heavy shape carried. */
interface StatementSizes {
  eventsInsert: number
  cellKeyLookup: number
}

function trackStatementSizes(): { sizes: StatementSizes; opts: TestDbOptions; reset(): void } {
  const sizes: StatementSizes = { eventsInsert: 0, cellKeyLookup: 0 }
  return {
    sizes,
    reset: () => {
      sizes.eventsInsert = 0
      sizes.cellKeyLookup = 0
    },
    opts: {
      onStatement: (sql, params) => {
        if (/INSERT INTO events\b/.test(sql)) {
          sizes.eventsInsert = Math.max(sizes.eventsInsert, params.length)
        } else if (/\(file_id, cell_id\) IN/.test(sql)) {
          sizes.cellKeyLookup = Math.max(sizes.cellKeyLookup, params.length)
        }
      },
    },
  }
}

describe("mirrorSync — an upstream past what one statement can carry (AQU-1543)", () => {
  it("seeds every file and cell of a 6,000-cell upstream on the first sync, hidden cells included", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t, "source")
      await emitUpstream(t, "file.create", { fileId: FILE_A, payload: { name: "Matthew", fileType: "codex" } })
      await emitUpstream(t, "file.create", { fileId: FILE_B, payload: { name: "Mark", fileType: "codex" } })
      // 6,000 cells + 2 files = 6,002 mirror events: 72,024 bound values in the
      // old single INSERT, against a ceiling of 65,533.
      await seedSourceCells(t, FILE_A, 3_500)
      await seedSourceCells(t, FILE_B, 2_500)
      await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_A, cellId: "cell-7", payload: { hidden: true } })
      await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_B, cellId: "cell-2400", payload: { hidden: true } })
      const head = await upstreamHead(t)

      const result = await mirrorSync(t.db, DOWNSTREAM)

      // 6,002, not 6,000 (AQU-1563): the sync folds in bounded windows, and the
      // two hidden cells were created in the first window and hidden in the
      // last, so each window mirrors its own state of them.
      expect(result).toMatchObject({ ranSync: true, cellsMirrored: 6_002, filesMirrored: 2, toSeq: head, more: false })
      expect(await downstreamFiles(t)).toEqual([
        { file_id: deterministicDownstreamFileId(DOWNSTREAM, FILE_B), name: "Mark", cells: 2_500, hidden: 1 },
        { file_id: deterministicDownstreamFileId(DOWNSTREAM, FILE_A), name: "Matthew", cells: 3_500, hidden: 1 },
      ])
      // The text is the upstream's, not just the row count — first and last
      // cell of the larger file, i.e. both ends of the chunked write.
      const text = await t.pg.query<{ cell_id: string; value: string }>(
        `SELECT cell_id, value FROM cells
          WHERE project_id = $1 AND file_id = $2 AND side = 'source' AND cell_id IN ('cell-1', 'cell-3500')
          ORDER BY cell_id`,
        [DOWNSTREAM, deterministicDownstreamFileId(DOWNSTREAM, FILE_A)],
      )
      expect(text.rows).toEqual([
        { cell_id: "cell-1", value: "Verse 1" },
        { cell_id: "cell-3500", value: "Verse 3500" },
      ])
      // The cursor moved — this is what a stuck link never managed, and why it
      // replayed the same doomed window on every open.
      expect(await downstreamCursor(t)).toBe(head)
      // Both sequence reservations were settled with the write, so nothing is
      // left holding the downstream's readers back.
      const pending = await t.pg.query(`SELECT 1 FROM seq_allocations WHERE project_id = $1`, [DOWNSTREAM])
      expect(pending.rows).toHaveLength(0)

      // Caught up means caught up: a second open mirrors nothing and writes no
      // further events.
      const before = await t.pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`,
        [DOWNSTREAM],
      )
      expect(await mirrorSync(t.db, DOWNSTREAM)).toMatchObject({ ranSync: false, cellsMirrored: 0 })
      const after = await t.pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`,
        [DOWNSTREAM],
      )
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    } finally {
      await t.close()
    }
  }, 120_000)
})

describe("mirrorSync — statement size does not grow with the upstream (AQU-1543)", () => {
  /** First sync of a `cells`-cell upstream; returns the biggest statement of
   *  each bind-heavy shape. */
  async function firstSyncSizes(consumes: Consumes, cells: number): Promise<StatementSizes> {
    const tracker = trackStatementSizes()
    const t = await makeTestDb({}, tracker.opts)
    try {
      await seedProjects(t, consumes)
      await emitUpstream(t, "file.create", { fileId: FILE_A, payload: { name: "Matthew", fileType: "codex" } })
      await seedSourceCells(t, FILE_A, cells)
      if (consumes === "target") await seedTargetCommits(t, FILE_A, cells)

      tracker.reset() // measure the sync, not the seeding
      // Windows of 1,100 events, so that EVERY run spans more than one window
      // and runs every statement shape a sync has: AQU-1567's look ahead
      // (deletedByHead) only reads on a window that is not the run's last, and
      // under the default 2,000 a 1,200-cell run is one window while a
      // 2,400-cell one is two. A window still holds more cells than one lookup
      // chunk and more events than one INSERT, so both bounds are exercised.
      const result = await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1_100 })
      expect(result).toMatchObject({ ranSync: true, cellsMirrored: cells, filesMirrored: 1 })
      expect((await downstreamFiles(t))[0]).toMatchObject({ name: "Matthew", cells })
      return { ...tracker.sizes }
    } finally {
      await t.close()
    }
  }

  it("consumes=source: twice the cells means more statements, not bigger ones", async () => {
    const small = await firstSyncSizes("source", 1_200)
    const large = await firstSyncSizes("source", 2_400)

    expect(large).toEqual(small)
    expect(small.eventsInsert).toBe(EVENT_INSERT_BULK_ROWS * EVENT_COLUMNS)
    expect(small.cellKeyLookup).toBeGreaterThan(0)
    expect(small.cellKeyLookup).toBeLessThan(small.eventsInsert)
  }, 120_000)

  it("consumes=target: the merge's upstream reads are bounded the same way", async () => {
    const small = await firstSyncSizes("target", 1_200)
    const large = await firstSyncSizes("target", 2_400)

    expect(large).toEqual(small)
    expect(small.eventsInsert).toBe(EVENT_INSERT_BULK_ROWS * EVENT_COLUMNS)
    expect(small.cellKeyLookup).toBeGreaterThan(0)
  }, 120_000)

  it("a later upstream change touching every cell is bounded too, and arrives", async () => {
    const tracker = trackStatementSizes()
    const t = await makeTestDb({}, tracker.opts)
    try {
      await seedProjects(t, "source")
      await emitUpstream(t, "file.create", { fileId: FILE_A, payload: { name: "Matthew", fileType: "codex" } })
      await seedSourceCells(t, FILE_A, 1_500)
      await mirrorSync(t.db, DOWNSTREAM)
      const firstSync = { ...tracker.sizes }

      // Now the lead parks all 1,500 cells. Nothing in this window carries
      // text, so the sync resolves every cell against the upstream's live rows
      // AND against the downstream's existing ones — both lookups are keyed
      // per cell, and both used to be a single list.
      await hideEveryCell(t, FILE_A, 1_500)
      tracker.reset()
      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result).toMatchObject({ ranSync: true, cellsMirrored: 1_500, filesMirrored: 0 })
      expect((await downstreamFiles(t))[0]).toMatchObject({ cells: 1_500, hidden: 1_500 })
      // Parking moved no text.
      const blank = await t.pg.query(
        `SELECT 1 FROM cells WHERE project_id = $1 AND side = 'source' AND value = '' LIMIT 1`,
        [DOWNSTREAM],
      )
      expect(blank.rows).toHaveLength(0)
      expect(tracker.sizes).toEqual(firstSync)
    } finally {
      await t.close()
    }
  }, 120_000)
})
