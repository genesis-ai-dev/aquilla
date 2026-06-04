import { describe, it, expect } from "vitest"
import { handleCellHistoryReadRequest } from "../events/cell-history-read-route"
import { type EventRow } from "./helpers/d1-fake"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cell-history-secret"

function envWith(db: D1Database) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

function makeEvent(
  over: Partial<EventRow> &
    Pick<EventRow, "id" | "kind" | "server_seq" | "parent_id">,
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

describe("GET /api/v1/projects/:projectId/files/:fileId/cells/:cellId/history", () => {
  it("returns the cell's events newest-first", async () => {
    const { db } = await makeTestDb({
      events: [
        makeEvent({ id: "e1", kind: "source.cell.create", parent_id: null, server_seq: 1, payload: '{"value":"hello"}' }),
        makeEvent({ id: "e2", kind: "target.cell.commit", parent_id: "e1", server_seq: 2, payload: '{"value":"hola"}' }),
        makeEvent({ id: "e3", kind: "target.cell.commit", parent_id: "e2", server_seq: 3, payload: '{"value":"adios"}' }),
        // Different file — must not appear in the response.
        makeEvent({ id: "x1", kind: "source.cell.create", parent_id: null, server_seq: 10, file_id: "file-other" }),
        // Different cell — must not appear.
        makeEvent({ id: "y1", kind: "target.cell.commit", parent_id: null, server_seq: 11, cell_id: "cell-2" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells/cell-1/history",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellHistoryReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ id: string; serverSeq: number; payload: unknown }> }
    expect(body.events.map((e) => e.id)).toEqual(["e3", "e2", "e1"])
    expect(body.events[0].payload).toEqual({ value: "adios" })
  })

  it("respects the limit parameter (clamped to 1..200)", async () => {
    const { db } = await makeTestDb({
      events: [
        makeEvent({ id: "e1", kind: "target.cell.commit", parent_id: null, server_seq: 1 }),
        makeEvent({ id: "e2", kind: "target.cell.commit", parent_id: "e1", server_seq: 2 }),
        makeEvent({ id: "e3", kind: "target.cell.commit", parent_id: "e2", server_seq: 3 }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells/cell-1/history?limit=2",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellHistoryReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(["e3", "e2"])
  })

  it("returns 401 without an Authorization header", async () => {
    const { db } = await makeTestDb({ events: [] })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells/cell-1/history",
    )
    const res = (await handleCellHistoryReadRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match", async () => {
    const { db } = await makeTestDb({ events: [] })
    const token = await makeTestToken(SECRET, { projectId: "other-proj", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells/cell-1/history",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellHistoryReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns an empty array for a cell with no events", async () => {
    const { db } = await makeTestDb({ events: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells/cell-empty/history",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellHistoryReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[] }
    expect(body.events).toEqual([])
  })

  it("returns null when the route doesn't match (other handlers can run)", async () => {
    const { db } = await makeTestDb({ events: [] })
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleCellHistoryReadRequest(req, envWith(db))
    expect(res).toBeNull()
  })
})
