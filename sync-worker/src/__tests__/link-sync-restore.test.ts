// AQU-1767 phase 2: an upstream lead UNDOING a removal reaches a linked
// downstream, the way the removal did. A restore carries no text (the upstream
// put back its archived rows), so the fold must read the upstream's live row —
// folded as content it would mirror an empty string; skipped, the downstream
// would keep the cell tombstoned for good.

import { describe, it, expect } from "vitest"
import { mirrorSync, laneRelevantHeadSeq, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { headParentFor } from "./helpers/chain-parent"

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
  | "source.cell.restore"

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-rst-${_seq}`
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
  const parentId = await headParentFor(t, UPSTREAM, kind, args.fileId, args.cellId, args.payload)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $9, $5, 'lead', $6, 1, $7, $8)`,
    [id, UPSTREAM, args.fileId ?? null, args.cellId ?? null, kind, JSON.stringify(args.payload), seq, seq, parentId],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId,
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
      WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [DOWNSTREAM, DOWNSTREAM_FILE, cellId],
  )
  const row = r.rows[0]
  if (!row) return undefined
  return { value: row.value, hidden: row.hidden_at != null }
}

async function downstreamTombstoned(t: TestDb, cellId: string): Promise<boolean | undefined> {
  const r = await t.pg.query<{ tombstoned_at: string | null }>(
    `SELECT tombstoned_at FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [DOWNSTREAM, DOWNSTREAM_FILE, cellId],
  )
  const row = r.rows[0]
  return row ? row.tombstoned_at != null : undefined
}

describe("mirrorSync — an upstream restore brings the cell back downstream (AQU-1767)", () => {
  it("removed, synced, restored, synced: the downstream cell is live with its text", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)
      await emitUpstream(t, "source.cell.delete", { fileId: FILE, cellId: "cell-2", payload: {} })
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamTombstoned(t, "cell-2")).toBe(true)

      await emitUpstream(t, "source.cell.restore", { fileId: FILE, cellId: "cell-2", payload: {} })
      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.cellsMirrored).toBe(1)
      expect(await downstreamTombstoned(t, "cell-2")).toBe(false)
      expect((await downstreamCell(t, "cell-2"))?.value).toBe("And the earth was void")
      expect((await downstreamCell(t, "cell-1"))?.value).toBe("In the beginning")
    } finally {
      await t.close()
    }
  })

  it("a removal and its undo inside ONE window leave the downstream cell as it was", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await mirrorSync(t.db, DOWNSTREAM)
      await emitUpstream(t, "source.cell.delete", { fileId: FILE, cellId: "cell-1", payload: {} })
      await emitUpstream(t, "source.cell.restore", { fileId: FILE, cellId: "cell-1", payload: {} })
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamTombstoned(t, "cell-1")).toBe(false)
      expect((await downstreamCell(t, "cell-1"))?.value).toBe("In the beginning")
    } finally {
      await t.close()
    }
  })

  it("the restore counts as a change for the freshness probe", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedTwoCells(t)
      await emitUpstream(t, "source.cell.delete", { fileId: FILE, cellId: "cell-2", payload: {} })
      const before = await laneRelevantHeadSeq(t.db, UPSTREAM, "source")
      const restore = await emitUpstream(t, "source.cell.restore", { fileId: FILE, cellId: "cell-2", payload: {} })
      expect(await laneRelevantHeadSeq(t.db, UPSTREAM, "source")).toBe(restore.seq)
      expect(restore.seq).toBeGreaterThan(before)
    } finally {
      await t.close()
    }
  })
})
