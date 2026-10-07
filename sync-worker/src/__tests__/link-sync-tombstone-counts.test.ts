// AQU-1564 — a cell the upstream deleted is not work in the downstream.
//
// A live link never deletes a downstream row when the upstream deletes the cell:
// `source.cell.mirror { deleted: true }` stamps `tombstoned_at` on the shared
// source row instead (AQU-476 §5), so a translation already made against it
// stays reviewable as "this line was removed upstream". That row is a review
// item, not a cell — and the counters that size the file's work kept counting
// it. A three-cell upstream with one cell deleted mirrored to a downstream whose
// `files.cell_count` read 3, and whose progress denominator read 3, while only
// two cells existed.
//
// Two shapes reach the downstream, and both are pinned:
//   1. The delete lands after the cell was mirrored: the existing row is
//      stamped and keeps its last text (and any translation made against it).
//   2. The create and the delete fold into the same sync: the downstream never
//      held the cell. It used to get an empty tombstoned row with nothing to
//      orphan; since AQU-1567 it gets no row at all, and the counts agree.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import {
  handleProgressReadRequest,
  readFirstOpenCell,
  type SectionProgressDetailResponse,
} from "../events/progress-read-route"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const UPSTREAM = "proj-upstream-tomb"
const DOWNSTREAM = "proj-downstream-tomb"
const FILE = "file-tomb"
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, 'live', 'source', 0)`,
    [DOWNSTREAM, UPSTREAM],
  )
}

let _id = 0

/** One upstream event through the front-door projection, with a real
 *  server_seq so the mirror's delta read sees it. */
async function emitUpstream(
  t: TestDb,
  kind: "file.create" | "source.cell.create" | "source.cell.delete",
  args: { cellId?: string; payload: Record<string, unknown> },
): Promise<void> {
  _id += 1
  const id = `evt-tomb-${_id}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  const seq = Number(seqRow.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'importer', $6, 1, 1, $7)`,
    [id, UPSTREAM, FILE, args.cellId ?? null, kind, JSON.stringify(args.payload), seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: FILE,
    cellId: args.cellId ?? null,
    parentId: null,
    kind,
    author: "importer",
    payload: args.payload,
    clientTs: 1,
    serverTs: 1,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

/** GEN 1:1–3 upstream, one source cell per verse. */
async function seedUpstreamFile(t: TestDb): Promise<void> {
  await emitUpstream(t, "file.create", { payload: { name: "Genesis", fileType: "codex" } })
  for (const n of [1, 2, 3]) {
    await emitUpstream(t, "source.cell.create", {
      cellId: `c${n}`,
      payload: { cellId: `c${n}`, value: `In the beginning ${n}`, canonicalRef: `GEN 1:${n}`, anchorCellId: null },
    })
  }
}

/** A downstream translator's work on one mirrored cell: a validated draft. */
async function translateDownstream(t: TestDb, cellId: string, value: string): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at, validated, word_count)
     VALUES ($1, $2, $3, 'target', '', $4, $5, 'translator', 2, 1, 2)`,
    [DOWNSTREAM, DOWNSTREAM_FILE, cellId, value, `evt-down-${cellId}`],
  )
}

interface Counters {
  cell_count: number
  filled_count: number
  approved_count: number
  word_count: number
}

async function countersOf(t: TestDb): Promise<Counters> {
  const r = await t.pg.query<Counters>(
    `SELECT cell_count, filled_count, approved_count, word_count FROM files WHERE project_id = $1 AND id = $2`,
    [DOWNSTREAM, DOWNSTREAM_FILE],
  )
  return r.rows[0]!
}

interface ProgressRow {
  scope: string
  section_key: string
  total_count: number
  filled_count: number
}

/**
 * The downstream's progress rows for ONE lane.
 *
 * AQU-1599 made the projection write a row per lane, the SOURCE lane included.
 * Which lane a reader wants depends on the number: the denominator is
 * lane-independent and lives on the source lane's row (the default here), while
 * a filled count belongs to the lane it was translated in. Reading every row
 * and taking `find(scope === 'file')` would return whichever lane the engine
 * listed first — and the source lane's `filled_count` is 0 by design.
 *
 * The source lane is also the only one these fixtures are guaranteed to have:
 * a downstream nobody has translated in yet has no target lane at all.
 */
async function progressOf(t: TestDb, role: "source" | "target" = "source"): Promise<ProgressRow[]> {
  const r = await t.pg.query<ProgressRow>(
    `SELECT p.scope, p.section_key, p.total_count, p.filled_count
       FROM file_section_progress p
       JOIN lanes l ON l.project_id = p.project_id AND l.id = p.lane_id
      WHERE p.project_id = $1 AND p.file_id = $2 AND l.role = $3
      ORDER BY p.scope, p.section_key`,
    [DOWNSTREAM, DOWNSTREAM_FILE, role],
  )
  return r.rows
}

async function tombstonedIds(t: TestDb): Promise<string[]> {
  const r = await t.pg.query<{ cell_id: string }>(
    `SELECT cell_id FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'source' AND tombstoned_at IS NOT NULL`,
    [DOWNSTREAM, DOWNSTREAM_FILE],
  )
  return r.rows.map((row) => row.cell_id)
}

describe("mirrorSync — a cell deleted upstream leaves the downstream's counts", () => {
  it("drops a mirrored-then-deleted cell from cell_count and the progress denominator", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await countersOf(t)).toMatchObject({ cell_count: 3 })

      await emitUpstream(t, "source.cell.delete", { cellId: "c3", payload: {} })
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await tombstonedIds(t)).toEqual(["c3"])
      expect(await countersOf(t)).toMatchObject({ cell_count: 2 })
      const progress = await progressOf(t)
      expect(progress.find((r) => r.scope === "file")).toMatchObject({ total_count: 2 })
      expect(progress.find((r) => r.scope === "section" && r.section_key === "GEN 1")).toMatchObject({ total_count: 2 })

      // The chapter's verse squares agree with that fraction.
      const secret = "tomb-secret"
      const token = await makeTestToken(secret, { projectId: DOWNSTREAM, fileId: DOWNSTREAM_FILE })
      const url = `https://worker/api/v1/projects/${DOWNSTREAM}/files/${DOWNSTREAM_FILE}/progress/sections/${encodeURIComponent("GEN 1")}`
      const response = (await handleProgressReadRequest(
        new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
        { AQUILLA_PG: t.db, SYNC_SECRET_KEY: secret },
      ))!
      expect(response.status).toBe(200)
      const detail = (await response.json()) as SectionProgressDetailResponse
      expect(detail.verses.map((v) => v.cellId)).toEqual(["c1", "c2"])
    } finally {
      await t.close()
    }
  })

  it("leaves a create and delete folded into the first sync out of the counts", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      await emitUpstream(t, "source.cell.delete", { cellId: "c3", payload: {} })
      await mirrorSync(t.db, DOWNSTREAM)

      // AQU-1567: never held downstream, so no row — not even a tombstone.
      expect(await tombstonedIds(t)).toEqual([])
      expect(await countersOf(t)).toMatchObject({ cell_count: 2 })
      expect((await progressOf(t)).find((r) => r.scope === "file")).toMatchObject({ total_count: 2 })
    } finally {
      await t.close()
    }
  })

  it("prunes a chapter whose every line the upstream deleted", async () => {
    // A surviving row would sit at its last count, and no later recompute would
    // revisit a section that has no live cells left in it.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      await emitUpstream(t, "source.cell.create", {
        cellId: "c4",
        payload: { cellId: "c4", value: "And the earth", canonicalRef: "GEN 2:1", anchorCellId: null },
      })
      await mirrorSync(t.db, DOWNSTREAM)
      expect((await progressOf(t)).some((r) => r.section_key === "GEN 2")).toBe(true)

      await emitUpstream(t, "source.cell.delete", { cellId: "c4", payload: {} })
      await mirrorSync(t.db, DOWNSTREAM)

      const progress = await progressOf(t)
      expect(progress.some((r) => r.section_key === "GEN 2")).toBe(false)
      expect(progress.find((r) => r.scope === "book" && r.section_key === "GEN")).toMatchObject({ total_count: 3 })
    } finally {
      await t.close()
    }
  })

  it("keeps a translation orphaned by the delete out of the numerators too", async () => {
    // The orphaned draft stays in `cells` for the review panel. If only the
    // denominator dropped it, two of two translated cells plus the orphan
    // would read as 3 of 2.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      await mirrorSync(t.db, DOWNSTREAM)
      await translateDownstream(t, "c1", "Au commencement")
      await translateDownstream(t, "c3", "Retiré en amont")

      await emitUpstream(t, "source.cell.delete", { cellId: "c3", payload: {} })
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await countersOf(t)).toEqual({ cell_count: 2, filled_count: 1, approved_count: 1, word_count: 2 })
      expect((await progressOf(t, "target")).find((r) => r.scope === "file"))
        .toMatchObject({ total_count: 2, filled_count: 1 })
      // The orphan itself is untouched.
      const orphan = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = 'c3' AND side = 'target'`,
        [DOWNSTREAM, DOWNSTREAM_FILE],
      )
      expect(orphan.rows).toEqual([{ value: "Retiré en amont" }])
    } finally {
      await t.close()
    }
  })

  it("never sends \"Go to first untranslated\" to a deleted line", async () => {
    // Progress no longer counts it, so landing there would open a removed line
    // as if it were the next piece of work.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      await mirrorSync(t.db, DOWNSTREAM)
      await translateDownstream(t, "c1", "Au commencement")
      expect(await readFirstOpenCell(t.db, DOWNSTREAM, DOWNSTREAM_FILE, "", "untranslated", "")).toBe("c2")

      await emitUpstream(t, "source.cell.delete", { cellId: "c2", payload: {} })
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await readFirstOpenCell(t.db, DOWNSTREAM, DOWNSTREAM_FILE, "", "untranslated", "")).toBe("c3")
    } finally {
      await t.close()
    }
  })
})
