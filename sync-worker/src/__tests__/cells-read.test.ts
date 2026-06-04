import { describe, it, expect } from "vitest"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { type CellRow } from "./helpers/d1-fake"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cells-read-secret"

function envWith(db: D1Database) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

function makeCell(over: Partial<CellRow> & Pick<CellRow, "cell_id" | "anchor_cell_id" | "event_id">): CellRow {
  return {
    project_id: "proj-a",
    file_id: "file-x",
    side: "target",
    value: "v",
    value_html: null,
    type: null,
    canonical_ref: null,
    last_editor: "alice",
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    source_event_id: null,
    ...over,
  }
}

describe("GET /api/v1/projects/:projectId/files/:fileId/cells", () => {
  it("returns cells in anchor-chain order (head → next → tail)", async () => {
    // Insert in a deliberately scrambled order — we want the chain walk to
    // reassemble them correctly regardless of source DB order.
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c3", anchor_cell_id: "c2", event_id: "e3" }),
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" }),
        makeCell({ cell_id: "c2", anchor_cell_id: "c1", event_id: "e2" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cells: Array<{ cellId: string; anchorCellId: string | null }> }
    expect(body.cells.map((c) => c.cellId)).toEqual(["c1", "c2", "c3"])
  })

  it("tiebreaks two cells anchored to the same parent by event_id lex order", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "head", anchor_cell_id: null, event_id: "ev0" }),
        makeCell({ cell_id: "second", anchor_cell_id: "head", event_id: "ev2" }),
        makeCell({ cell_id: "first", anchor_cell_id: "head", event_id: "ev1" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string }> }
    // head → first (ev1, smaller) → second (ev2)
    expect(body.cells.map((c) => c.cellId)).toEqual(["head", "first", "second"])
  })

  it("respects the side filter", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "s1", side: "source", anchor_cell_id: null, event_id: "es1", value: "src-1" }),
        makeCell({ cell_id: "t1", side: "target", anchor_cell_id: null, event_id: "et1", value: "tgt-1" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    const sourceReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const sourceRes = (await handleCellsReadRequest(sourceReq, envWith(db)))!
    const sourceBody = (await sourceRes.json()) as { cells: Array<{ side: string; cellId: string }> }
    expect(sourceBody.cells).toHaveLength(1)
    expect(sourceBody.cells[0].side).toBe("source")

    const targetReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const targetRes = (await handleCellsReadRequest(targetReq, envWith(db)))!
    const targetBody = (await targetRes.json()) as { cells: Array<{ side: string }> }
    expect(targetBody.cells).toHaveLength(1)
    expect(targetBody.cells[0].side).toBe("target")
  })

  it("returns both sides when side is omitted, source-rows first then target-rows", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", side: "source", anchor_cell_id: null, event_id: "es1", value: "src" }),
        makeCell({ cell_id: "c1", side: "target", anchor_cell_id: null, event_id: "et1", value: "tgt" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string; side: string }> }
    expect(body.cells).toHaveLength(2)
    expect(body.cells[0].side).toBe("source")
    expect(body.cells[1].side).toBe("target")
  })

  it("paginates via cursor and reports nextCursor when more rows remain", async () => {
    const cells = []
    let prev: string | null = null
    for (let i = 0; i < 10; i++) {
      const id = `c${i.toString().padStart(2, "0")}`
      cells.push(makeCell({ cell_id: id, anchor_cell_id: prev, event_id: `e${id}` }))
      prev = id
    }
    const { db } = await makeTestDb({ cells })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    const firstReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=4",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const firstRes = (await handleCellsReadRequest(firstReq, envWith(db)))!
    const firstBody = (await firstRes.json()) as {
      cells: Array<{ cellId: string }>
      nextCursor: string | null
      total: number
    }
    expect(firstBody.cells.map((c) => c.cellId)).toEqual(["c00", "c01", "c02", "c03"])
    expect(firstBody.nextCursor).not.toBeNull()
    expect(firstBody.total).toBe(10)

    const secondReq = new Request(
      `https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=4&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const secondRes = (await handleCellsReadRequest(secondReq, envWith(db)))!
    const secondBody = (await secondRes.json()) as {
      cells: Array<{ cellId: string }>
      nextCursor: string | null
    }
    expect(secondBody.cells.map((c) => c.cellId)).toEqual(["c04", "c05", "c06", "c07"])
    expect(secondBody.nextCursor).not.toBeNull()
  })

  it("returns 401 without an Authorization header", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const req = new Request("https://w/api/v1/projects/proj-a/files/file-x/cells")
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "other-proj", fileId: "file-x" })
    const req = new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns start_ms/end_ms as startMs/endMs", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1", start_ms: 1500, end_ms: 3250 }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ startMs: number | null; endMs: number | null }> }
    expect(body.cells[0].startMs).toBe(1500)
    expect(body.cells[0].endMs).toBe(3250)
  })

  it("returns 400 on invalid side parameter", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=invalid",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("exposes word_count and validated as boolean", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({
          cell_id: "c1",
          anchor_cell_id: null,
          event_id: "e1",
          word_count: 7,
          validated: 1,
        }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ wordCount: number; validated: boolean }> }
    expect(body.cells[0].wordCount).toBe(7)
    expect(body.cells[0].validated).toBe(true)
  })
})
