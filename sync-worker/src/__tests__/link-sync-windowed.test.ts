// AQU-1563: a live link to a VERY large upstream has to seed — in bounded
// windows.
//
// After AQU-1543 every statement the mirror sync sends was bounded, but the
// sync itself was not: the first sync of a new link read the upstream's whole
// history in one query and held all of it in memory at once — rows, folded
// cells, re-encoded mirror payloads, the driver's insert buffers. On dev a
// 22,838-cell / 52 MB upstream (two Biblica study-notes books) ran the
// ProjectSync Durable Object past its fixed 128 MB on every attempt. Batches
// that had committed stayed, but the cursor was only written at the very end,
// so it never moved, and every retry re-read and re-sent the whole history.
//
// The sync now folds the delta in bounded server_seq windows, commits each one
// with its cursor before reading the next, and one Durable Object invocation
// stops at a work budget while the /link/sync route calls again. Pinned here:
//
//   1. one sync brings a several-windows-long upstream fully across, and no
//      fold read spans more than one window (events, and payload bytes);
//   2. a failure partway leaves every finished window committed and claimed,
//      and the retry resumes there instead of starting over;
//   3. windowing changes nothing the downstream ends up with — a cell's
//      create, edit, hide/show, delete and its file's rename landing in
//      different windows end exactly where one window would put them, for
//      both link shapes;
//   4. a budgeted call stops with `more`, and the route keeps calling until
//      the link is caught up — and still answers 502 when an invocation fails.
//
// Memory itself cannot be measured here; what bounds it is that no read or
// write grows with the upstream, which (1) pins.

import { describe, it, expect } from "vitest"
import {
  mirrorSync,
  laneKindsFor,
  type MirrorSyncOptions,
  type MirrorSyncResult,
} from "../events/link-sync"
import { handleLinkSyncRequest, syncUntilCaughtUp } from "../events/link-sync-route"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb, type TestDbOptions } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const UPSTREAM = "proj-upstream-windowed"
const DOWNSTREAM = "proj-downstream-windowed"
/** A second downstream of the same upstream, synced in one window — the
 *  reference the windowed downstream's end state is compared against. */
const REFERENCE = "proj-downstream-reference"
const FILE_A = "file-acts"
const FILE_B = "file-isaiah"

type Consumes = "source" | "target"
type Gate = "head" | "validated"

async function seedProjects(
  t: TestDb,
  opts: { consumes?: Consumes; gate?: Gate; downstreams?: string[] } = {},
): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  for (const id of opts.downstreams ?? [DOWNSTREAM]) {
    await t.pg.query(
      `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor)
       VALUES ($1, $1, 1, $2, 'live', $3, $4, 0)`,
      [id, UPSTREAM, opts.consumes ?? "source", opts.gate ?? "head"],
    )
  }
}

let _id = 0

/** One upstream event through the front-door projection, at the next seq —
 *  the upstream's own `cells`/`files` rows are what the target merge and the
 *  visibility-only fallback read back, so they have to be the real ones. */
async function emitUpstream(
  t: TestDb,
  kind: string,
  args: { fileId: string; cellId?: string; payload: Record<string, unknown> },
): Promise<{ id: string; seq: number }> {
  _id += 1
  const id = `evt-win-${_id}`
  const row = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  const seq = Number(row.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'lead', $6, $7, $7, $7)`,
    [id, UPSTREAM, args.fileId, args.cellId ?? null, kind, JSON.stringify(args.payload), seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId,
    cellId: args.cellId ?? null,
    parentId: null,
    kind: kind as PersistedEvent["kind"],
    author: "lead",
    payload: args.payload,
    clientTs: seq,
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return { id, seq }
}

async function createFile(t: TestDb, fileId: string, name: string): Promise<void> {
  await emitUpstream(t, "file.create", { fileId, payload: { name, fileType: "codex" } })
}

async function createCells(t: TestDb, fileId: string, count: number, text = (n: number) => `Note ${n}`): Promise<void> {
  for (let n = 1; n <= count; n++) {
    await emitUpstream(t, "source.cell.create", {
      fileId,
      cellId: `${fileId}-c${n}`,
      payload: { cellId: `${fileId}-c${n}`, value: text(n), anchorCellId: null, canonicalRef: `ACT 1:${n}` },
    })
  }
}

async function upstreamHead(t: TestDb, consumes: Consumes = "source"): Promise<number> {
  const kinds = laneKindsFor(consumes)
  const r = await t.pg.query<{ head: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) AS head FROM events WHERE project_id = $1 AND kind = ANY($2)`,
    [UPSTREAM, kinds],
  )
  return Number(r.rows[0]?.head)
}

async function cursorOf(t: TestDb, project = DOWNSTREAM): Promise<number> {
  const r = await t.pg.query<{ c: string }>(`SELECT source_link_cursor AS c FROM projects WHERE id = $1`, [project])
  return Number(r.rows[0]?.c)
}

interface FileSummary {
  name: string
  cells: number
  cell_count: number
}

async function filesOf(t: TestDb, project = DOWNSTREAM): Promise<FileSummary[]> {
  const r = await t.pg.query<FileSummary>(
    `SELECT f.name, COUNT(c.cell_id)::int AS cells, f.cell_count
       FROM files f
       LEFT JOIN cells c
         ON c.project_id = f.project_id AND c.file_id = f.id AND c.side = 'source' AND c.tombstoned_at IS NULL
      WHERE f.project_id = $1
      GROUP BY f.id, f.name, f.cell_count
      ORDER BY f.name`,
    [project],
  )
  return r.rows
}

/**
 * What a downstream SHOWS for every mirrored cell, keyed by file NAME (each
 * downstream has its own deterministic file ids). A tombstoned row is reported
 * only as tombstoned: it keeps whatever text it last mirrored, and that text is
 * never shown. (A cell created and deleted within one run leaves no row at all,
 * however the run is windowed — AQU-1567.) Bookkeeping that is allowed to
 * differ by design (event ids, upstream_seq, timestamps) is left out.
 */
async function visibleState(t: TestDb, project: string): Promise<Record<string, unknown>[]> {
  const r = await t.pg.query<Record<string, unknown>>(
    `SELECT f.name AS file, c.cell_id,
            (c.tombstoned_at IS NOT NULL) AS tombstoned,
            CASE WHEN c.tombstoned_at IS NULL THEN c.value END AS value,
            CASE WHEN c.tombstoned_at IS NULL THEN c.value_html END AS value_html,
            CASE WHEN c.tombstoned_at IS NULL THEN c.type END AS type,
            CASE WHEN c.tombstoned_at IS NULL THEN c.canonical_ref END AS canonical_ref,
            CASE WHEN c.tombstoned_at IS NULL THEN c.start_ms END AS start_ms,
            CASE WHEN c.tombstoned_at IS NULL THEN c.end_ms END AS end_ms,
            CASE WHEN c.tombstoned_at IS NULL THEN c.metadata END AS metadata,
            (c.tombstoned_at IS NULL AND c.hidden_at IS NOT NULL) AS hidden
       FROM cells c
       JOIN files f ON f.id = c.file_id AND f.project_id = c.project_id
      WHERE c.project_id = $1 AND c.side = 'source'
      ORDER BY f.name, c.cell_id`,
    [project],
  )
  return r.rows
}

/** Every fold read of the upstream's events, by the window it asked for. */
interface DeltaRead {
  since: number
  until: number
}

function trackDeltaReads(): { reads: DeltaRead[]; opts: TestDbOptions } {
  const reads: DeltaRead[] = []
  return {
    reads,
    opts: {
      onStatement: (sql, params) => {
        if (/SELECT id, file_id, cell_id, kind, payload, server_seq\s+FROM events/.test(sql)) {
          reads.push({ since: Number(params[1]), until: Number(params[2]) })
        }
      },
    },
  }
}

async function laneEventsIn(t: TestDb, w: DeltaRead, consumes: Consumes = "source"): Promise<{ n: number; bytes: number }> {
  const r = await t.pg.query<{ n: number; bytes: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(octet_length(payload)), 0) AS bytes
       FROM events WHERE project_id = $1 AND server_seq > $2 AND server_seq <= $3 AND kind = ANY($4)`,
    [UPSTREAM, w.since, w.until, laneKindsFor(consumes)],
  )
  return { n: r.rows[0]!.n, bytes: Number(r.rows[0]!.bytes) }
}

describe("mirrorSync — the delta is folded in bounded windows (AQU-1563)", () => {
  it("brings an upstream several windows long across in one sync, and no read spans more than one window", async () => {
    const tracker = trackDeltaReads()
    const t = await makeTestDb({}, tracker.opts)
    try {
      await seedProjects(t)
      await createFile(t, FILE_A, "ACT-REV")
      await createFile(t, FILE_B, "ISA-MAL")
      await createCells(t, FILE_A, 70)
      await createCells(t, FILE_B, 50)
      await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_B, cellId: `${FILE_B}-c50`, payload: { hidden: true } })
      const head = await upstreamHead(t)
      tracker.reads.length = 0

      const result = await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 25 })

      // 2 files + 120 cells + 1 hide = 123 lane events → 5 windows of ≤ 25.
      expect(result).toMatchObject({ ranSync: true, windows: 5, more: false, fromSeq: 0, toSeq: head })
      expect(await cursorOf(t)).toBe(head)
      expect(await filesOf(t)).toEqual([
        { name: "ACT-REV", cells: 70, cell_count: 70 },
        // A parked cell leaves the file's count (AQU-1424).
        { name: "ISA-MAL", cells: 50, cell_count: 49 },
      ])
      const hidden = await t.pg.query(
        `SELECT cell_id FROM cells WHERE project_id = $1 AND hidden_at IS NOT NULL`,
        [DOWNSTREAM],
      )
      expect(hidden.rows).toEqual([{ cell_id: `${FILE_B}-c50` }])

      // The windows tile the delta: each starts where the last ended, the
      // last ends at the head, and none holds more than 25 lane events.
      expect(tracker.reads.map((w) => w.since)).toEqual([0, ...tracker.reads.slice(0, -1).map((w) => w.until)])
      expect(tracker.reads.at(-1)?.until).toBe(head)
      for (const w of tracker.reads) {
        expect((await laneEventsIn(t, w)).n).toBeLessThanOrEqual(25)
      }
      // One audit batch per window, every sequence reservation settled.
      const batches = await t.pg.query(
        `SELECT 1 FROM events WHERE project_id = $1 AND kind = 'link.cursor.advance'`,
        [DOWNSTREAM],
      )
      expect(batches.rows).toHaveLength(5)
      const pending = await t.pg.query(`SELECT 1 FROM seq_allocations WHERE project_id = $1`, [DOWNSTREAM])
      expect(pending.rows).toHaveLength(0)

      // Caught up is caught up.
      expect(await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 25 })).toMatchObject({ ranSync: false, windows: 0 })
    } finally {
      await t.close()
    }
  }, 120_000)

  it("ends a window at its payload budget too, and a single event over budget is still a window of its own", async () => {
    const tracker = trackDeltaReads()
    const t = await makeTestDb({}, tracker.opts)
    try {
      await seedProjects(t)
      await createFile(t, FILE_A, "ACT-REV")
      // ~1 KB study notes with curly quotes (stored two bytes per character in
      // JS), and one 20 KB note — bigger than a whole window's budget.
      await createCells(t, FILE_A, 30, (n) => (n === 12 ? "“".repeat(10_000) : `“Note ${n}” `.repeat(90)))
      const head = await upstreamHead(t)
      tracker.reads.length = 0

      const budget = 6 * 1024
      const result = await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1000, windowBytes: budget })

      expect(result).toMatchObject({ ranSync: true, more: false, toSeq: head })
      expect(result.windows).toBeGreaterThan(5)
      expect(await filesOf(t)).toEqual([{ name: "ACT-REV", cells: 30, cell_count: 30 }])
      let oversized = 0
      for (const w of tracker.reads) {
        const { n, bytes } = await laneEventsIn(t, w)
        if (n === 1 && bytes > budget) oversized++
        else expect(bytes).toBeLessThanOrEqual(budget)
      }
      expect(oversized).toBe(1)
    } finally {
      await t.close()
    }
  }, 120_000)
})

describe("mirrorSync — an interrupted sync resumes at its last finished window (AQU-1563)", () => {
  it("keeps every committed window, claims it in the cursor, and the retry reads only what is left", async () => {
    let failOnCursorAdvance = 0 // fail the Nth window's commit; 0 = never
    let cursorAdvances = 0
    const tracker = trackDeltaReads()
    const t = await makeTestDb({}, {
      onStatement: (sql, params) => {
        tracker.opts.onStatement?.(sql, params)
        if (/INSERT INTO events\b/.test(sql) && params.includes("link.cursor.advance")) {
          cursorAdvances++
          if (cursorAdvances === failOnCursorAdvance) throw new Error("connection lost mid-sync")
        }
      },
    })
    try {
      await seedProjects(t)
      await createFile(t, FILE_A, "ACT-REV")
      await createCells(t, FILE_A, 99) // 100 lane events → 5 windows of 20
      const head = await upstreamHead(t)

      // The third window's final batch dies (as an isolate killed mid-sync would).
      failOnCursorAdvance = 3
      await expect(mirrorSync(t.db, DOWNSTREAM, { windowEvents: 20 })).rejects.toThrow("connection lost mid-sync")
      const claimed = await cursorOf(t)
      expect(claimed).toBe(tracker.reads[1]?.until) // the end of window 2
      expect(claimed).toBeGreaterThan(0)

      // The retry starts from the claim, not from 0, and finishes.
      failOnCursorAdvance = 0
      tracker.reads.length = 0
      const retry = await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 20 })
      expect(tracker.reads[0]?.since).toBe(claimed)
      expect(retry).toMatchObject({ ranSync: true, more: false, fromSeq: claimed, toSeq: head, windows: 3 })
      expect(await cursorOf(t)).toBe(head)

      // Exactly one copy of everything.
      expect(await filesOf(t)).toEqual([{ name: "ACT-REV", cells: 99, cell_count: 99 }])
      const dupes = await t.pg.query(
        `SELECT cell_id FROM cells WHERE project_id = $1 GROUP BY file_id, cell_id, side HAVING COUNT(*) > 1`,
        [DOWNSTREAM],
      )
      expect(dupes.rows).toHaveLength(0)
      const mirrors = await t.pg.query<{ n: number }>(
        `SELECT COUNT(DISTINCT cell_id)::int AS n FROM events WHERE project_id = $1 AND kind = 'source.cell.mirror'`,
        [DOWNSTREAM],
      )
      expect(mirrors.rows[0]?.n).toBe(99)
    } finally {
      await t.close()
    }
  }, 120_000)
})

describe("mirrorSync — windows change nothing the downstream ends up with (AQU-1563)", () => {
  /** Upstream history in which the same cells are touched again and again,
   *  so that with one event per window every step lands in a window of its
   *  own: create (with an import envelope), edit, hide, show, hide-then-edit,
   *  delete, a file rename — and filler cells around them. */
  async function seedEventfulHistory(t: TestDb): Promise<void> {
    await createFile(t, FILE_A, "ACT-REV")
    await emitUpstream(t, "source.cell.create", {
      fileId: FILE_A,
      cellId: "intro",
      payload: {
        cellId: "intro",
        value: "Acts Preface",
        valueHtml: "<p>Acts Preface</p>",
        type: "paratext",
        anchorCellId: null,
        metadata: { aquillaImport: { milestone: { title: "Acts Preface" } } },
      },
    })
    await createCells(t, FILE_A, 6)
    await emitUpstream(t, "source.cell.commit", { fileId: FILE_A, cellId: `${FILE_A}-c1`, payload: { value: "Note 1, revised" } })
    await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_A, cellId: `${FILE_A}-c2`, payload: { hidden: true } })
    await emitUpstream(t, "source.cell.delete", { fileId: FILE_A, cellId: `${FILE_A}-c3`, payload: {} })
    await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_A, cellId: `${FILE_A}-c4`, payload: { hidden: true } })
    await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_A, cellId: `${FILE_A}-c4`, payload: { hidden: false } })
    // AQU-1546: hidden, then edited — stays hidden.
    await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_A, cellId: `${FILE_A}-c5`, payload: { hidden: true } })
    await emitUpstream(t, "source.cell.commit", { fileId: FILE_A, cellId: `${FILE_A}-c5`, payload: { value: "Note 5, revised while parked" } })
    await emitUpstream(t, "source.cell.commit", { fileId: FILE_A, cellId: "intro", payload: { value: "Acts Preface (rev.)" } })
    await emitUpstream(t, "file.rename", { fileId: FILE_A, payload: { name: "ACT-REV (2026)" } })
    await createFile(t, FILE_B, "ISA-MAL")
    await createCells(t, FILE_B, 3)
    await emitUpstream(t, "source.cell.delete", { fileId: FILE_B, cellId: `${FILE_B}-c2`, payload: {} })
  }

  it("consumes=source: one event per window ends exactly where one window does", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t, { downstreams: [DOWNSTREAM, REFERENCE] })
      await seedEventfulHistory(t)
      const head = await upstreamHead(t)

      const windowed = await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1 })
      const reference = await mirrorSync(t.db, REFERENCE)

      expect(reference.windows).toBe(1)
      expect(windowed.windows).toBe(head) // every lane event its own window
      expect(await visibleState(t, DOWNSTREAM)).toEqual(await visibleState(t, REFERENCE))
      expect(await filesOf(t, DOWNSTREAM)).toEqual(await filesOf(t, REFERENCE))
      // And the reference is what the history says, so equal is not "equally
      // wrong". (Live cells only: `cell_count` also leaves out the two parked
      // cells but, today, still counts the mirrored tombstones — the same on
      // both sides, and not this ticket's.)
      expect((await filesOf(t, REFERENCE)).map(({ name, cells }) => ({ name, cells }))).toEqual([
        { name: "ACT-REV (2026)", cells: 6 },
        { name: "ISA-MAL", cells: 2 },
      ])
      const byId = new Map((await visibleState(t, REFERENCE)).map((r) => [r.cell_id, r]))
      expect(byId.get("intro")).toMatchObject({
        value: "Acts Preface (rev.)",
        type: "paratext",
        metadata: { aquillaImport: { milestone: { title: "Acts Preface" } } },
        hidden: false,
      })
      expect(byId.get(`${FILE_A}-c1`)).toMatchObject({ value: "Note 1, revised", hidden: false })
      expect(byId.get(`${FILE_A}-c2`)).toMatchObject({ hidden: true })
      // AQU-1567: created and deleted before the downstream's first sync, so
      // the downstream never held it — no row, not an empty tombstone. The
      // equality above pins that one-event windows agree.
      expect(byId.has(`${FILE_A}-c3`)).toBe(false)
      expect(byId.has(`${FILE_B}-c2`)).toBe(false)
      expect(byId.get(`${FILE_A}-c4`)).toMatchObject({ hidden: false })
      expect(byId.get(`${FILE_A}-c5`)).toMatchObject({ value: "Note 5, revised while parked", hidden: true })
      expect(await cursorOf(t, DOWNSTREAM)).toBe(head)
      expect(await cursorOf(t, REFERENCE)).toBe(head)
    } finally {
      await t.close()
    }
  }, 120_000)

  /** A chain upstream: source cells, translations committed and validated in
   *  separate events, a draft over a validated translation, a re-translation
   *  that is validated again, and a cell never translated. */
  async function seedTranslatedHistory(t: TestDb): Promise<void> {
    await createFile(t, FILE_A, "ACT-REV")
    await createCells(t, FILE_A, 5)
    const translate = async (n: number, value: string, validate: boolean) => {
      const commit = await emitUpstream(t, "target.cell.commit", { fileId: FILE_A, cellId: `${FILE_A}-c${n}`, payload: { value } })
      if (validate) {
        await emitUpstream(t, "cell.validate", { fileId: FILE_A, cellId: `${FILE_A}-c${n}`, payload: { editEventId: commit.id } })
      }
    }
    await translate(1, "Nota 1", true)
    await translate(2, "Nota 2", true)
    await translate(3, "Nota 3 (borrador)", false)
    await translate(2, "Nota 2 (borrador)", false) // draft over a validated translation
    await translate(4, "Nota 4", true)
    await translate(4, "Nota 4 (rev.)", true) // re-translated and validated again
    await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE_A, cellId: `${FILE_A}-c1`, payload: { hidden: true } })
    // c5 is never translated.
  }

  for (const gate of ["validated", "head"] as const) {
    it(`consumes=target, gate=${gate}: one event per window ends exactly where one window does`, async () => {
      const t = await makeTestDb()
      try {
        await seedProjects(t, { consumes: "target", gate, downstreams: [DOWNSTREAM, REFERENCE] })
        await seedTranslatedHistory(t)
        const head = await upstreamHead(t, "target")

        const windowed = await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1 })
        const reference = await mirrorSync(t.db, REFERENCE)

        expect(reference.windows).toBe(1)
        expect(windowed.windows).toBeGreaterThan(10)
        expect(await visibleState(t, DOWNSTREAM)).toEqual(await visibleState(t, REFERENCE))
        const values = Object.fromEntries((await visibleState(t, REFERENCE)).map((r) => [r.cell_id, r.value]))
        expect(values).toEqual(
          gate === "validated"
            ? { [`${FILE_A}-c1`]: "Nota 1", [`${FILE_A}-c4`]: "Nota 4 (rev.)" }
            : {
                [`${FILE_A}-c1`]: "Nota 1",
                [`${FILE_A}-c2`]: "Nota 2 (borrador)",
                [`${FILE_A}-c3`]: "Nota 3 (borrador)",
                [`${FILE_A}-c4`]: "Nota 4 (rev.)",
              },
        )
        expect(await cursorOf(t, DOWNSTREAM)).toBe(head)
        expect(await cursorOf(t, REFERENCE)).toBe(head)
      } finally {
        await t.close()
      }
    }, 120_000)
  }
})

describe("one sync request, many bounded invocations (AQU-1563)", () => {
  const SECRET = "test-secret-aqu-1563"
  /** One budget-limited invocation, as the ProjectSync DO runs it: a zero
   *  budget means exactly one window per call. */
  const invocation: MirrorSyncOptions = { windowEvents: 10, budgetMs: 0 }

  async function seedThirtyCells(t: TestDb): Promise<number> {
    await seedProjects(t)
    await createFile(t, FILE_A, "ACT-REV")
    await createCells(t, FILE_A, 29) // 30 lane events → 3 windows of 10
    return upstreamHead(t)
  }

  it("a budgeted call stops after its budget with `more`, its windows claimed", async () => {
    const t = await makeTestDb()
    try {
      const head = await seedThirtyCells(t)
      let clock = 1_000
      const first = await mirrorSync(t.db, DOWNSTREAM, {
        windowEvents: 10,
        budgetMs: 15,
        // The budget is read once at the start (1,010 → deadline 1,025) and
        // checked before every window after the first, 10 ms apart: 1,020 lets
        // a second window start, 1,030 stops the third.
        now: () => (clock += 10),
      })
      expect(first).toMatchObject({ ranSync: true, windows: 2, more: true })
      expect(await cursorOf(t)).toBe(first.toSeq)
      expect(first.toSeq).toBeLessThan(head)

      const rest = await mirrorSync(t.db, DOWNSTREAM, invocation)
      expect(rest).toMatchObject({ ranSync: true, windows: 1, more: false, fromSeq: first.toSeq, toSeq: head })
    } finally {
      await t.close()
    }
  }, 120_000)

  it("syncUntilCaughtUp keeps calling until the link is caught up, and caps a runaway", async () => {
    const t = await makeTestDb()
    try {
      const head = await seedThirtyCells(t)
      let calls = 0
      const capped = await syncUntilCaughtUp(() => {
        calls++
        return mirrorSync(t.db, DOWNSTREAM, invocation)
      }, 2)
      expect(calls).toBe(2)
      expect(capped).toMatchObject({ more: true, windows: 2 })

      calls = 0
      const done = await syncUntilCaughtUp(() => {
        calls++
        return mirrorSync(t.db, DOWNSTREAM, invocation)
      })
      expect(calls).toBe(1)
      expect(done).toMatchObject({ ranSync: true, more: false, toSeq: head })
      expect(await filesOf(t)).toEqual([{ name: "ACT-REV", cells: 29, cell_count: 29 }])
    } finally {
      await t.close()
    }
  }, 120_000)

  /** A ProjectSync namespace whose DO runs one budgeted invocation per fetch,
   *  and can be told to fail one of them. */
  function fakeProjectSync(t: TestDb, failOnCall = 0): { ns: DurableObjectNamespace; calls: () => number } {
    let calls = 0
    const stub = {
      fetch: async () => {
        calls++
        if (calls === failOnCall) return new Response("mirror sync failed", { status: 500 })
        const result: MirrorSyncResult = await mirrorSync(t.db, DOWNSTREAM, invocation)
        return Response.json(result)
      },
    }
    const ns = { idFromName: (name: string) => name, get: () => stub } as unknown as DurableObjectNamespace
    return { ns, calls: () => calls }
  }

  async function postLinkSync(t: TestDb, ns: DurableObjectNamespace): Promise<Response> {
    const token = await makeTestToken(SECRET, { projectId: DOWNSTREAM, fileId: "__project__", role: 100 })
    const res = await handleLinkSyncRequest(
      new Request(`https://sync.test/api/v1/projects/${DOWNSTREAM}/link/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET, ProjectSync: ns },
    )
    return res!
  }

  it("POST /link/sync answers once the link is caught up, however many invocations that took", async () => {
    const t = await makeTestDb()
    try {
      const head = await seedThirtyCells(t)
      const { ns, calls } = fakeProjectSync(t)

      const res = await postLinkSync(t, ns)

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ projectId: DOWNSTREAM, ranSync: true, more: false, windows: 3, toSeq: head })
      expect(calls()).toBe(3)
      expect(await filesOf(t)).toEqual([{ name: "ACT-REV", cells: 29, cell_count: 29 }])
    } finally {
      await t.close()
    }
  }, 120_000)

  it("POST /link/sync still answers 502 when an invocation fails, with the finished windows kept", async () => {
    const t = await makeTestDb()
    try {
      const head = await seedThirtyCells(t)

      const failed = await postLinkSync(t, fakeProjectSync(t, 2).ns)
      expect(failed.status).toBe(502)
      const claimed = await cursorOf(t)
      expect(claimed).toBeGreaterThan(0)
      expect(claimed).toBeLessThan(head)

      // The caller's "Try again" picks up from there.
      const { ns, calls } = fakeProjectSync(t)
      const retried = await postLinkSync(t, ns)
      expect(retried.status).toBe(200)
      expect(await retried.json()).toMatchObject({ fromSeq: claimed, toSeq: head, more: false })
      expect(calls()).toBe(2)
    } finally {
      await t.close()
    }
  }, 120_000)
})
