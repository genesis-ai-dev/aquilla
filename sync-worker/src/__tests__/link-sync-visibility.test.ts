// AQU-1453: a live link mirrors hide/show, not just text.
//
// Hiding a cell (AQU-1422) is how a lead curates a source — the row keeps its
// text, its translations, its recordings, and stops being offered for work. A
// downstream that consumes that source has to see the same curation, or it
// keeps counting, exporting and drafting verses the upstream parked.
//
// The bug had three layers and each one alone was enough to lose the change, so
// each is pinned separately below:
//
//   1. `source.cell.visibility.set` was not a LANE-RELEVANT kind, so the
//      freshness probe read "not behind" and no sync ran at all.
//   2. A hide moves no text, so the hash-equal no-op suppression dropped it even
//      once a sync did run.
//   3. `source.cell.mirror` had nowhere to carry visibility, so the projection
//      could not write it.
//
// And one trap worth a test of its own: a hide carries no value, so a fold that
// treated it as content would mirror an empty string over the downstream's text
// — a hide that deletes the verse it was meant to park.

import { describe, it, expect } from "vitest"
import { mirrorSync, laneRelevantHeadSeq, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-upstream"
const DOWNSTREAM = "proj-downstream"
const FILE = "file-gen"
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)

type UpstreamKind =
  | "file.create"
  | "source.cell.create"
  | "source.cell.commit"
  | "source.cell.delete"
  | "source.cell.visibility.set"

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-vis-${_seq}`
}

async function seedProjects(t: TestDb, mode: "live" | "clone" = "live"): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, $3, 'source', 0)`,
    [DOWNSTREAM, UPSTREAM, mode],
  )
}

/** Apply one upstream event through the front-door projection, with a real
 *  server_seq so the freshness probe and the delta fold both see it. */
async function emitUpstream(
  t: TestDb,
  kind: UpstreamKind,
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown> },
): Promise<{ id: string; seq: number }> {
  const id = nextId()
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  const seq = Number(seqRow.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'lead', $6, 1, $7, $8)`,
    [id, UPSTREAM, args.fileId ?? null, args.cellId ?? null, kind, JSON.stringify(args.payload), seq, seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId: null,
    kind,
    author: "lead",
    payload: args.payload,
    clientTs: 1,
    // A hide stamps `hidden_at` with the event's serverTs, so it has to be
    // truthy — 0 would project as "visible" and quietly hollow out the test.
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return { id, seq }
}

async function seedTwoCells(t: TestDb): Promise<void> {
  await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "cell-1",
    payload: { cellId: "cell-1", value: "In the beginning", anchorCellId: null, canonicalRef: "GEN 1:1" },
  })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "cell-2",
    payload: { cellId: "cell-2", value: "And the earth was void", anchorCellId: null, canonicalRef: "GEN 1:2" },
  })
}

async function downstreamCell(
  t: TestDb,
  cellId: string,
): Promise<{ value: string; hidden: boolean } | undefined> {
  const r = await t.pg.query<{ value: string; hidden_at: string | null }>(
    `SELECT value, hidden_at FROM cells
      WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source' AND target_lang = ''`,
    [DOWNSTREAM, DOWNSTREAM_FILE, cellId],
  )
  const row = r.rows[0]
  if (!row) return undefined
  return { value: row.value, hidden: row.hidden_at != null }
}

async function upstreamHide(t: TestDb, cellId: string, hidden: boolean): Promise<void> {
  await emitUpstream(t, "source.cell.visibility.set", { fileId: FILE, cellId, payload: { hidden } })
}

describe("mirrorSync — upstream hide/show reaches the downstream (AQU-1453)", () => {
  it("a hide with no text change still mirrors, and parks the downstream row", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      // First sync brings the two visible cells across.
      await mirrorSync(t.db, DOWNSTREAM)
      expect((await downstreamCell(t, "cell-2"))?.hidden).toBe(false)

      // The upstream lead parks cell-2 and changes nothing else. This is the
      // case every layer of the bug swallowed: no text moved, so there is
      // nothing for a content-shaped sync to notice.
      await upstreamHide(t, "cell-2", true)
      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)
      expect(result.skippedHashEqual).toBe(0)
      const mirrored = await downstreamCell(t, "cell-2")
      expect(mirrored?.hidden).toBe(true)
      // The text survived the hide — parking a cell keeps its source.
      expect(mirrored?.value).toBe("And the earth was void")
      // The cell nobody touched is untouched.
      expect((await downstreamCell(t, "cell-1"))?.hidden).toBe(false)
    } finally {
      await t.close()
    }
  })

  it("a later show brings the cell back, without a re-import", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)
      await upstreamHide(t, "cell-1", true)
      await mirrorSync(t.db, DOWNSTREAM)
      expect((await downstreamCell(t, "cell-1"))?.hidden).toBe(true)

      await upstreamHide(t, "cell-1", false)
      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.cellsMirrored).toBe(1)
      const shown = await downstreamCell(t, "cell-1")
      expect(shown?.hidden).toBe(false)
      expect(shown?.value).toBe("In the beginning")
    } finally {
      await t.close()
    }
  })

  it("a hide and a show inside ONE sync window fold to the final state", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)

      // Parked, then un-parked, before the downstream ever syncs again.
      await upstreamHide(t, "cell-2", true)
      await upstreamHide(t, "cell-2", false)
      await mirrorSync(t.db, DOWNSTREAM)

      expect((await downstreamCell(t, "cell-2"))?.hidden).toBe(false)
    } finally {
      await t.close()
    }
  })

  it("an edit and a hide in the same window both arrive", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)

      await emitUpstream(t, "source.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "In the beginning, God" },
      })
      await upstreamHide(t, "cell-1", true)
      await mirrorSync(t.db, DOWNSTREAM)

      const cell = await downstreamCell(t, "cell-1")
      expect(cell?.value).toBe("In the beginning, God")
      expect(cell?.hidden).toBe(true)
    } finally {
      await t.close()
    }
  })

  it("a text-only mirror does NOT un-park a cell the upstream still has hidden", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)
      await upstreamHide(t, "cell-2", true)
      await mirrorSync(t.db, DOWNSTREAM)
      expect((await downstreamCell(t, "cell-2"))?.hidden).toBe(true)

      // A later edit to the SAME parked cell. The mirror event carries no
      // visibility (nothing changed about it), and the projection must read
      // that as "leave it alone" rather than "make it visible".
      await emitUpstream(t, "source.cell.commit", {
        fileId: FILE,
        cellId: "cell-2",
        payload: { value: "And the earth was formless" },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      const cell = await downstreamCell(t, "cell-2")
      expect(cell?.value).toBe("And the earth was formless")
      expect(cell?.hidden).toBe(true)
    } finally {
      await t.close()
    }
  })

  it("a visibility event for a cell deleted upstream mirrors nothing over its text", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)

      // The delete tombstones on its own. The visibility event that follows has
      // no live upstream row to resolve against, and must not be turned into a
      // mirror carrying an empty value.
      await emitUpstream(t, "source.cell.delete", { fileId: FILE, cellId: "cell-2", payload: {} })
      await upstreamHide(t, "cell-2", true)
      await mirrorSync(t.db, DOWNSTREAM)

      const r = await t.pg.query<{ value: string; tombstoned_at: string | null }>(
        `SELECT value, tombstoned_at FROM cells
          WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source' AND target_lang = ''`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-2"],
      )
      expect(r.rows[0]?.tombstoned_at).not.toBeNull()
    } finally {
      await t.close()
    }
  })

  it("running the sync twice is idempotent — the second pass mirrors nothing", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)
      await upstreamHide(t, "cell-2", true)
      await mirrorSync(t.db, DOWNSTREAM)

      const second = await mirrorSync(t.db, DOWNSTREAM)
      expect(second.cellsMirrored).toBe(0)
      expect((await downstreamCell(t, "cell-2"))?.hidden).toBe(true)
    } finally {
      await t.close()
    }
  })

  it("a clone-mode link still never syncs — an upstream hide does not reach it", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t, "clone")
      await seedTwoCells(t)
      await upstreamHide(t, "cell-2", true)

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(false)
    } finally {
      await t.close()
    }
  })
})

describe("laneRelevantHeadSeq — visibility is lane-relevant (AQU-1453)", () => {
  it("a bare hide makes the downstream behind; before this fix it read caught-up", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      const caughtUp = await laneRelevantHeadSeq(t.db, UPSTREAM, "source")

      await upstreamHide(t, "cell-2", true)
      const afterHide = await laneRelevantHeadSeq(t.db, UPSTREAM, "source")

      expect(afterHide).toBeGreaterThan(caughtUp)
    } finally {
      await t.close()
    }
  })
})
