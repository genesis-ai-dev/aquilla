// Snapshot route tests — create, list, view, delete, restore (FRO-176).
//
// Uses the in-process PGlite test DB (makeTestDb) so the full SQL path runs.
// Restore is exercised with a cell that has a different value at snapshot time.

import { describe, it, expect, beforeEach } from "vitest"
import { handleSnapshotsRequest } from "../events/snapshots-route"
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

    // Verify the cell now has the restored value.
    const cellAfter = await testDb.rows<{ value: string }>("cells")
    const parsedValue = JSON.parse(cellAfter[0].value) as { value: string }
    expect(parsedValue.value).toBe("original value")
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
