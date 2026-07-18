// Tests for the AQU-498 per-member activity read route.
import { describe, it, expect } from "vitest"
import { handleMemberActivityReadRequest } from "../events/member-activity-read-route"
import { type EventRow } from "./helpers/in-memory-db"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "member-activity-secret"

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function makeEvent(
  over: Partial<EventRow> & Pick<EventRow, "id" | "kind" | "server_seq" | "parent_id">,
): EventRow {
  return {
    schema_version: 1,
    project_id: "proj-a",
    file_id: "file-x",
    cell_id: "cell-1",
    author: "alice",
    payload: "{}",
    client_ts: 1700000000000,
    server_ts: 1700000000000 + over.server_seq * 1000,
    ...over,
  }
}

const FILE_ROW = {
  id: "file-x",
  project_id: "proj-a",
  name: "Genesis",
  event_id: "genesis-head",
}

const CELL_ROW_BASE = {
  project_id: "proj-a",
  file_id: "file-x",
  side: "target",
  value: "hello world",
  event_id: "e1",
  last_edit_at: 1700000005000,
}

describe("GET /api/v1/projects/:projectId/members/:author/activity", () => {
  it("returns the member's recent events newest-first, scoped to the project", async () => {
    const { db } = await makeTestDb({
      events: [
        makeEvent({ id: "e1", kind: "target.cell.commit", parent_id: null, server_seq: 1, author: "alice" }),
        makeEvent({ id: "e2", kind: "target.cell.commit", parent_id: "e1", server_seq: 2, author: "alice" }),
        // Different author — must not appear.
        makeEvent({ id: "b1", kind: "target.cell.commit", parent_id: null, server_seq: 3, author: "bob" }),
        // Different project — must not appear.
        makeEvent({ id: "p1", kind: "target.cell.commit", parent_id: null, server_seq: 4, author: "alice", project_id: "proj-other" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role: 600 })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/members/alice/activity",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleMemberActivityReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { recentEvents: Array<{ id: string }> }
    expect(body.recentEvents.map((e) => e.id)).toEqual(["e2", "e1"])
  })

  it("returns a files rollup of cells/words/timing derived from the cells projection", async () => {
    const { db } = await makeTestDb({
      files: [FILE_ROW],
      cells: [
        { ...CELL_ROW_BASE, cell_id: "c1", last_editor: "alice", word_count: 2 },
        { ...CELL_ROW_BASE, cell_id: "c2", last_editor: "alice", word_count: 3, last_edit_at: 1700000006000 },
        // Someone else's cell in the same file — must not count toward alice's rollup.
        { ...CELL_ROW_BASE, cell_id: "c3", last_editor: "bob", word_count: 10 },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role: 600 })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/members/alice/activity",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleMemberActivityReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      fileRollup: Array<{ fileId: string; fileName: string; cellsTouched: number; wordCount: number; lastActivityAt: number | null }>
    }
    expect(body.fileRollup).toEqual([
      { fileId: "file-x", fileName: "Genesis", cellsTouched: 2, wordCount: 5, lastActivityAt: 1700000006000 },
    ])
  })

  it("returns 403 when the caller's role is below the org's memberProgressViewMinRole floor", async () => {
    const { db } = await makeTestDb({
      organizations: [{ id: 1, name: "Org A" }],
      projects: [{ id: "proj-a", org_id: 1, name: "Proj A" }],
      org_settings: [{ org_id: 1, settings: JSON.stringify({ memberProgressViewMinRole: 600 }) }],
      events: [makeEvent({ id: "e1", kind: "target.cell.commit", parent_id: null, server_seq: 1, author: "alice" })],
    })
    // Contributor (400) is below the configured floor (600 = Maintainer).
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role: 400 })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/members/alice/activity",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleMemberActivityReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("allows a caller meeting the default MAINTAINER floor when the org has not configured one", async () => {
    const { db } = await makeTestDb({
      events: [makeEvent({ id: "e1", kind: "target.cell.commit", parent_id: null, server_seq: 1, author: "alice" })],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role: 600 })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/members/alice/activity",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleMemberActivityReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
  })

  it("returns 401 without an Authorization header", async () => {
    const { db } = await makeTestDb({ events: [] })
    const req = new Request("https://w/api/v1/projects/proj-a/members/alice/activity")
    const res = (await handleMemberActivityReadRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match", async () => {
    const { db } = await makeTestDb({ events: [] })
    const token = await makeTestToken(SECRET, { projectId: "other-proj", fileId: "file-x", role: 700 })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/members/alice/activity",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleMemberActivityReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns null when the route doesn't match (other handlers can run)", async () => {
    const { db } = await makeTestDb({ events: [] })
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleMemberActivityReadRequest(req, envWith(db))
    expect(res).toBeNull()
  })
})
