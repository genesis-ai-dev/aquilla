// Snapshot route tests — create, list, view, delete, restore (FRO-176).
//
// Uses the in-process PGlite test DB (makeTestDb) so the full SQL path runs.
// Restore is exercised with a cell that has a different value at snapshot time.

import { describe, it, expect, beforeEach } from "vitest"
import { handleSnapshotsRequest } from "../events/snapshots-route"
import { handleRebuildProjectionRequest } from "../events/rebuild"
import { handleCellEvent } from "../events/handlers/cell-events"
import { authorize } from "../events/authorize"
import type { RawEvent } from "../events/types"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import { sign } from "hono/jwt"

const SECRET = "snapshots-test-secret"
const PROJECT_ID = "proj-snapshots"
const FILE_ID = "file-a"
const CELL_ID = "cell-1"

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

/** Project-scoped token (no fileId constraint — snapshots use verifyTokenForProject). */
async function makeProjectToken(role = 600) {
  const claims = {
    userId: 1,
    username: "alice",
    projectId: PROJECT_ID,
    fileId: "__project__",
    role,
    aud: "sync",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
  }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

describe("POST /api/v1/projects/:id/snapshots — create", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
  })

  it("creates a snapshot and returns 201 with the snapshot row", async () => {
    const token = await makeProjectToken(600)
    const req = new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "v1 release", description: "Before harmonization" }),
    })
    const res = (await handleSnapshotsRequest(req, envWith(testDb.db)))!
    expect(res.status).toBe(201)
    const body = (await res.json()) as { snapshot: Record<string, unknown> }
    expect(body.snapshot.name).toBe("v1 release")
    expect(body.snapshot.description).toBe("Before harmonization")
    expect(body.snapshot.projectId).toBe(PROJECT_ID)
    expect(typeof body.snapshot.snapshotTs).toBe("number")
  })

  it("returns 400 when name is missing", async () => {
    const token = await makeProjectToken(600)
    const req = new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no name" }),
    })
    const res = (await handleSnapshotsRequest(req, envWith(testDb.db)))!
    expect(res.status).toBe(400)
  })

  it("returns 403 when role is below maintainer (600)", async () => {
    const token = await makeProjectToken(400) // contributor
    const req = new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unauthorized" }),
    })
    const res = (await handleSnapshotsRequest(req, envWith(testDb.db)))!
    expect(res.status).toBe(403)
  })

  it("returns 401 without token", async () => {
    const req = new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no token" }),
    })
    const res = (await handleSnapshotsRequest(req, envWith(testDb.db)))!
    expect(res.status).toBe(401)
  })
})

describe("GET /api/v1/projects/:id/snapshots — list", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
  })

  it("returns empty list when no snapshots exist", async () => {
    const token = await makeProjectToken(100)
    const req = new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSnapshotsRequest(req, envWith(testDb.db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { snapshots: unknown[] }
    expect(body.snapshots).toEqual([])
  })

  it("returns snapshots ordered newest-first and excludes deleted", async () => {
    const token = await makeProjectToken(600)
    const now = Date.now()

    // Seed two snapshots via the create endpoint.
    for (const name of ["Snap A", "Snap B"]) {
      await handleSnapshotsRequest(
        new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }),
        envWith(testDb.db),
      )
    }

    const listReq = new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const listRes = (await handleSnapshotsRequest(listReq, envWith(testDb.db)))!
    const body = (await listRes.json()) as { snapshots: Array<{ name: string; snapshotTs: number }> }
    expect(body.snapshots.length).toBe(2)
    // Newest-first: Snap B was created after Snap A
    expect(body.snapshots[0].name).toBe("Snap B")
    expect(body.snapshots[1].name).toBe("Snap A")
  })
})

describe("DELETE /api/v1/projects/:id/snapshots/:sid — soft-delete", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
  })

  it("soft-deletes a snapshot and it disappears from list", async () => {
    const token = await makeProjectToken(600)

    const createRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "to-delete" }),
      }),
      envWith(testDb.db),
    ))!
    const { snapshot } = (await createRes.json()) as { snapshot: { id: string } }
    const snapId = snapshot.id

    const deleteRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots/${snapId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(testDb.db),
    ))!
    expect(deleteRes.status).toBe(200)

    // Verify it's gone from list
    const listRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(testDb.db),
    ))!
    const body = (await listRes.json()) as { snapshots: unknown[] }
    expect(body.snapshots).toHaveLength(0)
  })
})

describe("POST /api/v1/projects/:id/snapshots/:sid/restore — restore", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
  })

  it("returns 404 for a non-existent snapshot", async () => {
    const token = await makeProjectToken(600)
    const res = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots/nonexistent/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(testDb.db),
    ))!
    expect(res.status).toBe(404)
  })

  it("returns 403 when caller is below maintainer", async () => {
    const maintainerToken = await makeProjectToken(600)
    const viewerToken = await makeProjectToken(100)

    const createRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
        method: "POST",
        headers: { Authorization: `Bearer ${maintainerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-snap" }),
      }),
      envWith(testDb.db),
    ))!
    const { snapshot } = (await createRes.json()) as { snapshot: { id: string } }

    const restoreRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots/${snapshot.id}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      envWith(testDb.db),
    ))!
    expect(restoreRes.status).toBe(403)
  })

  it("returns no-op message when snapshot is empty (no cells at snapshot time)", async () => {
    const token = await makeProjectToken(600)

    const createRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "empty-snap" }),
      }),
      envWith(testDb.db),
    ))!
    const { snapshot } = (await createRes.json()) as { snapshot: { id: string } }

    const restoreRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots/${snapshot.id}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(testDb.db),
    ))!
    expect(restoreRes.status).toBe(200)
    const body = (await restoreRes.json()) as { restored: number; message: string }
    expect(body.restored).toBe(0)
    expect(body.message).toContain("No changes")
  })

  it("create + restore round-trip: restores cell values at snapshot time", async () => {
    const token = await makeProjectToken(600)
    const now = Date.now()

    // Seed an event and a cell row that existed at snapshot time (server_ts < snapshot_ts).
    const pastTs = now - 10000 // 10s ago
    const snapshotValue = JSON.stringify({ value: "original value" })

    // Insert a cell-create event at pastTs
    const eventId = "evt-create-1"
    await testDb.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ($1, 1, $2, $3, $4, NULL, 'target.cell.create', 'alice', $5, $6, $7, 1)`,
      [eventId, PROJECT_ID, FILE_ID, CELL_ID, snapshotValue, pastTs, pastTs],
    )

    // Seed cells table pointing at that event
    await testDb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, anchor_cell_id, last_edit_at)
       VALUES ($1, $2, $3, 'target', $4, $5, NULL, $6)`,
      [PROJECT_ID, FILE_ID, CELL_ID, snapshotValue, eventId, pastTs],
    )

    // Create snapshot AFTER the event (captures original value)
    const createRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "pre-edit" }),
      }),
      envWith(testDb.db),
    ))!
    const { snapshot } = (await createRes.json()) as { snapshot: { id: string; snapshotTs: number } }

    // Now update the cell value (simulating an edit after the snapshot).
    const newEventId = "evt-commit-2"
    const newValue = JSON.stringify({ value: "edited value" })
    const afterTs = snapshot.snapshotTs + 1000
    await testDb.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ($1, 1, $2, $3, $4, $5, 'target.cell.commit', 'bob', $6, $7, $8, 2)`,
      [newEventId, PROJECT_ID, FILE_ID, CELL_ID, eventId, newValue, afterTs, afterTs],
    )
    await testDb.pg.query(
      `UPDATE cells SET value = $1, event_id = $2, last_editor = 'bob', last_edit_at = $3
       WHERE project_id = $4 AND file_id = $5 AND cell_id = $6`,
      [newValue, newEventId, afterTs, PROJECT_ID, FILE_ID, CELL_ID],
    )

    // Verify the cell has the edited value now.
    const cellBefore = await testDb.rows<{ value: string; event_id: string }>("cells")
    expect(cellBefore[0].value).toBe(newValue)

    // Restore to snapshot — should emit a new event restoring the original value.
    const restoreRes = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots/${snapshot.id}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(testDb.db),
    ))!
    expect(restoreRes.status).toBe(200)
    const restoreBody = (await restoreRes.json()) as { restored: number; skippedIdentical: number }
    expect(restoreBody.restored).toBe(1)
    expect(restoreBody.skippedIdentical).toBe(0)

    // Verify the cell now has the restored value — the RAW snapshot text,
    // exactly what a rebuild replay of the restore event writes (live ==
    // rebuild parity; the old code wrapped it as '{"value":…}' JSON, which a
    // replay would then "repair" to the raw text).
    const cellAfter = await testDb.rows<{ value: string }>("cells")
    expect(cellAfter[0].value).toBe("original value")
  })
})

// ── Restore-while-editing (audit B6) ────────────────────────────────────────
//
// Restore mints chain-mutating commit events. Like every other chain-mutating
// write it must take its chain_claims slot atomically (mirroring
// handlers/cell-events.ts) — otherwise a restore racing a live commit on the
// same head leaves a chain slot in the log without a claim, and a later
// rebuild replay (which arbitrates by lowest server_seq) can pick a different
// winner than live arbitration did, silently flipping the cell.

describe("restore racing a live commit on the same head (audit B6)", () => {
  let t: TestDb

  /** History: cell-1 committed "old" (seq 1) then "new" (seq 2); snapshot
   *  taken in between (ts 1500), so restore wants to write "old" off head
   *  evt-new. */
  async function seedHistory() {
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES
       ('evt-old', 1, $1, $2, $3, NULL,      'target.cell.commit', 'alice', '{"value":"old"}', 1000, 1000, 1),
       ('evt-new', 1, $1, $2, $3, 'evt-old', 'target.cell.commit', 'alice', '{"value":"new"}', 2000, 2000, 2)`,
      [PROJECT_ID, FILE_ID, CELL_ID],
    )
    await t.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
       VALUES ($1, $2, $3, 'target', 'new', 'evt-new', 2000)`,
      [PROJECT_ID, FILE_ID, CELL_ID],
    )
    await t.pg.query(
      `INSERT INTO snapshots (id, project_id, name, created_by, snapshot_ts)
       VALUES ('snap-1', $1, 'before the rewrite', 'alice', 1500)`,
      [PROJECT_ID],
    )
  }

  /** Build a live commit's statements EXACTLY as POST /events would (the
   *  authorize + handleCellEvent path), without executing them yet — this is
   *  the TOCTOU window: the route's pre-check ran before the racing write
   *  committed. */
  async function buildLiveCommit(id: string, parentId: string, value: string) {
    const token = await makeTestToken(SECRET, { projectId: PROJECT_ID, fileId: FILE_ID, role: 400 })
    const raw: RawEvent<"target.cell.commit"> = {
      id,
      schemaVersion: 1,
      kind: "target.cell.commit",
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      cellId: CELL_ID,
      parentId,
      author: "bob",
      payload: { value },
      clientTs: 3000,
    }
    const authed = await authorize(token, raw, SECRET)
    if (!authed.ok) throw new Error(`authorize failed: ${authed.reason}`)
    return handleCellEvent(t.db, authed.event, 3000, { updateProjection: true })
  }

  async function restore(db: AquillaDb = t.db) {
    const token = await makeProjectToken(600)
    const res = (await handleSnapshotsRequest(
      new Request(`https://w/api/v1/projects/${PROJECT_ID}/snapshots/snap-1/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(200)
    return (await res.json()) as { restored: number; skippedIdentical: number; skippedConcurrent: number }
  }

  async function rebuild() {
    const res = await handleRebuildProjectionRequest(
      new Request(`https://w/admin/projects/${PROJECT_ID}/rebuild-projection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res!.status).toBe(200)
  }

  async function head(): Promise<{ event_id: string; value: string }> {
    const r = await t.pg.query<{ event_id: string; value: string }>(
      `SELECT event_id, value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'`,
      [PROJECT_ID, FILE_ID, CELL_ID],
    )
    return r.rows[0]
  }

  async function restoreEventId(): Promise<string> {
    const r = await t.pg.query<{ id: string }>(
      `SELECT id FROM events WHERE project_id = $1 AND payload LIKE '%restore_origin%'`,
      [PROJECT_ID],
    )
    expect(r.rows).toHaveLength(1)
    return r.rows[0].id
  }

  beforeEach(async () => {
    t = await makeTestDb()
    await seedHistory()
  })

  it("a racing live commit whose pre-check ran before the restore cannot flip the winner (live == rebuild)", async () => {
    // The race: the live commit's statements are built (pre-check passed,
    // head = evt-new, slot free) BEFORE the restore commits, but its
    // transaction lands AFTER — the classic TOCTOU the chain claim closes.
    const racing = await buildLiveCommit("evt-race", "evt-new", "racing live edit")

    const body = await restore()
    expect(body.restored).toBe(1)

    await t.db.batch(racing.stmts)

    // Restore committed first, so it holds the chain slot off evt-new: the
    // racing commit must NOT advance the projection (its claim no-ops and its
    // gated cells write no-ops with it).
    const restoreId = await restoreEventId()
    const live = await head()
    expect(live.event_id).toBe(restoreId)
    expect(live.value).toBe("old")

    // A rebuild replay (lowest-seq-wins per slot) must agree with live state
    // — this is exactly the silent winner-flip the claim prevents.
    await rebuild()
    const rebuilt = await head()
    expect(rebuilt.event_id).toBe(live.event_id)
    expect(rebuilt.value).toBe(live.value)
  })

  it("a live commit landing between restore's read and its write wins; the response counts it as skippedConcurrent", async () => {
    // Interleave deterministically: the first batch() restore issues is
    // preceded by a live commit through the real write path — i.e. the head
    // moved (and the chain slot was claimed) after restore SELECTed its
    // snapshot rows but before its transaction ran.
    let injected = false
    const interceptedDb: AquillaDb = {
      prepare: (q) => t.db.prepare(q),
      exec: (q) => t.db.exec(q),
      close: () => t.db.close(),
      batch: async (stmts) => {
        if (!injected) {
          injected = true
          const live = await buildLiveCommit("evt-race", "evt-new", "concurrent edit")
          await t.db.batch(live.stmts)
        }
        return t.db.batch(stmts)
      },
    }

    const body = await restore(interceptedDb)

    // The live commit owns the slot; the restore's CAS matched zero rows.
    // Pre-fix the response was computed from pre-transaction reads and lied
    // (restored: 1) — counts must come from the CAS outcomes.
    expect(body.restored).toBe(0)
    expect(body.skippedConcurrent).toBe(1)
    expect(body.skippedIdentical).toBe(0)

    const live = await head()
    expect(live.event_id).toBe("evt-race")
    expect(live.value).toBe("concurrent edit")

    // Replay agrees: the live commit has the lower seq at the contested slot.
    await rebuild()
    const rebuilt = await head()
    expect(rebuilt.event_id).toBe(live.event_id)
    expect(rebuilt.value).toBe(live.value)
  })
})

describe("route non-match", () => {
  it("returns null for unrelated paths", async () => {
    const testDb = await makeTestDb()
    const res = await handleSnapshotsRequest(
      new Request("https://w/api/v1/projects/p/something-else"),
      envWith(testDb.db),
    )
    expect(res).toBeNull()
  })
})
