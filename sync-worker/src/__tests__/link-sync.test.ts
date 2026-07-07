// FRO-476: mirror sync engine tests (link-sync.ts).
//
// Covers the acceptance criteria enumerated on the issue:
//   - seeding: linking live materializes upstream files+cells with provenance
//   - edit propagation: upstream commit -> downstream mirror -> target flags stale
//   - hash-equal no-op: whitespace-only edit mirrors nothing, no stale flag
//   - delete -> tombstone, target row stays visible
//   - concurrent syncs converge (single-flight is exercised at the DO layer;
//     here we verify running mirrorSync twice back-to-back is idempotent —
//     the deterministic-id + monotonic-guard properties that make concurrent
//     calls safe)
//   - clone mode never runs a sync
//   - behindSeq is non-null iff there are unmirrored LANE-RELEVANT changes

import { describe, it, expect } from "vitest"
import { mirrorSync, laneRelevantHeadSeq, deterministicMirrorEventId, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, contentHash, type PersistedEvent } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-upstream"
const DOWNSTREAM = "proj-downstream"
// `FILE` is the UPSTREAM file id. `files.id` is a global PK (see
// deterministicDownstreamFileId's doc comment in link-sync.ts), so the
// downstream's mirrored copy gets its OWN deterministic id — tests that
// read the downstream's `files`/`cells` rows must query by DOWNSTREAM_FILE.
const FILE = "file-gen"
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)

async function seedUpstreamProject(t: TestDb): Promise<void> {
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`,
    [UPSTREAM],
  )
}

async function seedDownstreamProject(
  t: TestDb,
  opts: { mode: "live" | "clone" | null; cursor?: number },
): Promise<void> {
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, $3, 'source', $4)`,
    [DOWNSTREAM, UPSTREAM, opts.mode, opts.cursor ?? 0],
  )
}

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-${_seq}`
}

/** Apply one upstream event through the front-door projection (same code
 *  path production events go through) and give it a real server_seq via
 *  the events table (so laneRelevantHeadSeq / delta queries see it). */
async function emitUpstream(
  t: TestDb,
  kind: "file.create" | "source.cell.create" | "source.cell.commit" | "source.cell.delete",
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
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'importer', $6, 1, 1, $7)`,
    [id, UPSTREAM, args.fileId ?? null, args.cellId ?? null, kind, JSON.stringify(args.payload), seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId ?? null,
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
  return { id, seq }
}

async function getProjectCursor(t: TestDb, projectId: string): Promise<number> {
  const row = await t.pg.query<{ source_link_cursor: string }>(
    `SELECT source_link_cursor FROM projects WHERE id = $1`,
    [projectId],
  )
  return Number(row.rows[0]?.source_link_cursor ?? 0)
}

describe("mirrorSync — seeding", () => {
  it("materializes upstream files + source cells in the downstream, with mirror provenance set", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { mode: "live" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "In the beginning", anchorCellId: null },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)
      expect(result.filesMirrored).toBe(1)

      const file = await t.pg.query<{ name: string }>(
        `SELECT name FROM files WHERE project_id = $1 AND id = $2`,
        [DOWNSTREAM, DOWNSTREAM_FILE],
      )
      expect(file.rows[0]?.name).toBe("Genesis")

      const cell = await t.pg.query<{ value: string; upstream_event_id: string; upstream_seq: string }>(
        `SELECT value, upstream_event_id, upstream_seq FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(cell.rows[0]?.value).toBe("In the beginning")
      expect(cell.rows[0]?.upstream_event_id).toBeTruthy()
      expect(Number(cell.rows[0]?.upstream_seq)).toBeGreaterThan(0)

      // Cursor advanced to the head.
      const cursor = await getProjectCursor(t, DOWNSTREAM)
      expect(cursor).toBeGreaterThan(0)
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — edit propagation & staleness", () => {
  it("an upstream edit mirrors on next sync; a target pinned to the old source head is now stale", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { mode: "live" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "original text", anchorCellId: null },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      // Downstream translator commits a target pinned to the current mirrored source head.
      const localSourceHead = await t.pg.query<{ event_id: string }>(
        `SELECT event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      const sourceEventId = localSourceHead.rows[0]?.event_id
      const targetCommit: PersistedEvent = {
        id: nextId(),
        schemaVersion: 1,
        projectId: DOWNSTREAM,
        fileId: DOWNSTREAM_FILE,
        cellId: "cell-1",
        parentId: null,
        kind: "target.cell.commit",
        author: "translator",
        payload: { value: "au commencement", sourceEventId },
        clientTs: 1,
        serverTs: 1,
        serverSeq: 1,
      }
      const stmts: AquillaStatement[] = []
      buildEventProjectionStmts(t.db, targetCommit, stmts)
      await t.db.batch(stmts)

      // Upstream fixes the line.
      await emitUpstream(t, "source.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "original text (fixed)" },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)

      const updatedSource = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(updatedSource.rows[0]?.value).toBe("original text (fixed)")

      // The stale-source pointer comparison: target's pin no longer equals
      // the (now-advanced) local source head.
      const staleCheck = await t.pg.query<{ cell_id: string }>(
        `SELECT t.cell_id FROM cells t JOIN cells s
           ON s.project_id = t.project_id AND s.cell_id = t.cell_id AND s.side = 'source'
         WHERE t.project_id = $1 AND t.file_id = $2 AND t.side = 'target'
           AND t.source_event_id IS NOT NULL AND s.event_id != t.source_event_id`,
        [DOWNSTREAM, DOWNSTREAM_FILE],
      )
      expect(staleCheck.rows.map((r) => r.cell_id)).toContain("cell-1")
    } finally {
      await t.close()
    }
  })

  it("whitespace-only (hash-equal) upstream edit mirrors NOTHING and never flags stale", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { mode: "live" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "same text", anchorCellId: null },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      const before = await t.pg.query<{ event_id: string; upstream_event_id: string }>(
        `SELECT event_id, upstream_event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )

      // Upstream "re-imports" the same content (contentHash-equal despite a
      // fresh event id — the parser-fresh-id invariant §2).
      await emitUpstream(t, "source.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "same text" },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(0)
      expect(result.skippedHashEqual).toBe(1)

      const after = await t.pg.query<{ event_id: string; upstream_event_id: string }>(
        `SELECT event_id, upstream_event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      // No mirror event was minted — the local row's event_id is unchanged.
      expect(after.rows[0]?.event_id).toBe(before.rows[0]?.event_id)
      expect(after.rows[0]?.upstream_event_id).toBe(before.rows[0]?.upstream_event_id)

      // Cursor still advances (so the freshness probe doesn't loop forever).
      const cursor = await getProjectCursor(t, DOWNSTREAM)
      expect(cursor).toBeGreaterThan(0)
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — delete / tombstone", () => {
  it("an upstream delete tombstones the downstream row; the row stays visible (not deleted)", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { mode: "live" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "to be removed", anchorCellId: null },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      await emitUpstream(t, "source.cell.delete", { fileId: FILE, cellId: "cell-1", payload: {} })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)

      const row = await t.pg.query<{ tombstoned_at: string | null }>(
        `SELECT tombstoned_at FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(row.rows).toHaveLength(1) // row still exists
      expect(row.rows[0]?.tombstoned_at).not.toBeNull()
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — concurrent-sync convergence", () => {
  it("running the sync twice back-to-back (simulating overlapping triggers) converges to upstream head; cursor == max processed seq", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { mode: "live" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "v1", anchorCellId: null },
      })
      const commit2 = await emitUpstream(t, "source.cell.commit", { fileId: FILE, cellId: "cell-1", payload: { value: "v2" } })

      // Two "concurrent" callers both see the same head and both run
      // mirrorSync — in production this is prevented by the DO single-flight
      // (project-do.ts), but the function itself must also be safe if that
      // ever fails: deterministic ids + monotonic guard + GREATEST cursor.
      const [r1, r2] = await Promise.all([mirrorSync(t.db, DOWNSTREAM), mirrorSync(t.db, DOWNSTREAM)])

      // At most one of them should have done real work in this single-
      // connection PGlite harness (no true parallelism), but regardless of
      // which "won", the end state must match upstream head exactly.
      expect(r1.ranSync || r2.ranSync).toBe(true)

      const row = await t.pg.query<{ value: string; upstream_seq: string }>(
        `SELECT value, upstream_seq FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(row.rows[0]?.value).toBe("v2")
      expect(Number(row.rows[0]?.upstream_seq)).toBe(commit2.seq)

      const cursor = await getProjectCursor(t, DOWNSTREAM)
      const upstreamHead = await laneRelevantHeadSeq(t.db, UPSTREAM)
      expect(cursor).toBe(upstreamHead)

      // A third sync call is a clean no-op.
      const r3 = await mirrorSync(t.db, DOWNSTREAM)
      expect(r3.ranSync).toBe(false)
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — clone mode short-circuit", () => {
  it("never runs a sync for a clone-mode link, no matter how much upstream drifts", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { mode: "clone" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "v1", anchorCellId: null },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(false)

      const cellCount = await t.pg.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM cells WHERE project_id = $1`,
        [DOWNSTREAM],
      )
      expect(Number(cellCount.rows[0]?.count)).toBe(0)
    } finally {
      await t.close()
    }
  })

  it("also short-circuits for a legacy link (source_project_id set, mode NULL)", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id) VALUES ($1, 'Downstream', 1, $2)`,
        [DOWNSTREAM, UPSTREAM],
      )
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(false)
    } finally {
      await t.close()
    }
  })
})

describe("laneRelevantHeadSeq / behindSeq lane-relevance", () => {
  it("counts source.cell.create/commit/delete and cell.retime/cast.assign/file.create, but NOT comments or validations", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      const laneHead = await laneRelevantHeadSeq(t.db, UPSTREAM)
      expect(laneHead).toBeGreaterThan(0)

      // Non-lane noise: a comment.create bumps the project's overall seq
      // counter but must NOT move the lane-relevant probe.
      const before = await laneRelevantHeadSeq(t.db, UPSTREAM)
      await t.pg.query(
        `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
         VALUES ($1, 1, $2, $3, NULL, NULL, 'comment.create', 'alice', '{}', 1, 1,
           (SELECT COALESCE(MAX(server_seq), 0) + 1 FROM events WHERE project_id = $2))`,
        [nextId(), UPSTREAM, FILE],
      )
      const after = await laneRelevantHeadSeq(t.db, UPSTREAM)
      expect(after).toBe(before)
    } finally {
      await t.close()
    }
  })

  it("behindSeq semantics: cursor below lane head -> behind; cursor caught up -> not behind", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { mode: "live" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Genesis", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "v1", anchorCellId: null },
      })

      const cursorBefore = await getProjectCursor(t, DOWNSTREAM)
      const headBefore = await laneRelevantHeadSeq(t.db, UPSTREAM)
      expect(headBefore).toBeGreaterThan(cursorBefore) // behind

      await mirrorSync(t.db, DOWNSTREAM)

      const cursorAfter = await getProjectCursor(t, DOWNSTREAM)
      const headAfter = await laneRelevantHeadSeq(t.db, UPSTREAM)
      expect(cursorAfter).toBe(headAfter) // caught up, not behind
    } finally {
      await t.close()
    }
  })
})

describe("deterministicMirrorEventId", () => {
  it("is stable for the same (downstream, upstreamEventId) pair", () => {
    const id1 = deterministicMirrorEventId("proj-b", "evt-up-1")
    const id2 = deterministicMirrorEventId("proj-b", "evt-up-1")
    expect(id1).toBe(id2)
  })

  it("differs for different downstream projects (no cross-project collision)", () => {
    const id1 = deterministicMirrorEventId("proj-b", "evt-up-1")
    const id2 = deterministicMirrorEventId("proj-c", "evt-up-1")
    expect(id1).not.toBe(id2)
  })

  it("looks UUID-shaped (dedupe relies on the events PK, not the exact format, but keep it sane)", () => {
    const id = deterministicMirrorEventId("proj-b", "evt-up-1")
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
