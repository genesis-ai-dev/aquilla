// GET /migrate/cell-ids — the projection's current cells for one migrated file,
// so the migration CLI can retract cells Codex removed from its notebook
// entirely (AQU-910). Event ids are one-way UUIDv5, so /migrate/event-ids can't
// enumerate them.
import { describe, it, expect, afterAll } from "vitest"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { handleMigrateCellIdsRequest } from "../events/migrate-cell-ids-route"

const SECRET = "cell-ids-secret"

interface CellsBody {
  cells: {
    cellId: string
    hasSource: boolean
    hasTarget: boolean
    sourceAnchorCellId: string | null
  }[]
  lastCellId: string
  more: boolean
}

const req = (query: string, auth = `Bearer ${SECRET}`) =>
  new Request(`https://sync.example/migrate/cell-ids?${query}`, { headers: { Authorization: auth } })

function cell(over: { cell_id: string; side: string; project_id?: string; file_id?: string }) {
  return {
    project_id: "proj-a",
    file_id: "file-x",
    value: "v",
    value_html: null,
    type: null,
    canonical_ref: null,
    anchor_cell_id: null,
    event_id: `ev-${over.cell_id}-${over.side}`,
    source_event_id: null,
    last_editor: "migrate",
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    ...over,
  }
}

let t: TestDb
afterAll(async () => {
  await t?.close()
})

describe("handleMigrateCellIdsRequest", () => {
  it("collapses a cell's sides into one row, scoped to project + file", async () => {
    t = await makeTestDb({
      cells: [
        cell({ cell_id: "c1", side: "source" }),
        cell({ cell_id: "c1", side: "target" }),
        cell({ cell_id: "c2", side: "source" }),
        cell({ cell_id: "other-file", side: "source", file_id: "file-y" }),
        cell({ cell_id: "other-proj", side: "source", project_id: "proj-b" }),
      ],
    })

    const res = await handleMigrateCellIdsRequest(req("projectId=proj-a&fileId=file-x"), {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    })

    expect(res?.status).toBe(200)
    const body = (await res!.json()) as CellsBody
    expect(body.cells).toEqual([
      { cellId: "c1", hasSource: true, hasTarget: true, sourceAnchorCellId: null },
      { cellId: "c2", hasSource: true, hasTarget: false, sourceAnchorCellId: null },
    ])
    expect(body.more).toBe(false)
  })

  it("carries the SOURCE row's anchor per cell — null for a target-only cell (AQU-931)", async () => {
    t = await makeTestDb({
      cells: [
        cell({ cell_id: "v1", side: "source" }),
        // v2's source anchors to v1; its target row's anchor must not leak in.
        { ...cell({ cell_id: "v2", side: "source" }), anchor_cell_id: "v1" },
        { ...cell({ cell_id: "v2", side: "target" }), anchor_cell_id: "target-noise" },
        cell({ cell_id: "v3", side: "target" }),
      ],
    })

    const res = await handleMigrateCellIdsRequest(req("projectId=proj-a&fileId=file-x"), {
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
    })
    const body = (await res!.json()) as CellsBody
    expect(body.cells).toEqual([
      { cellId: "v1", hasSource: true, hasTarget: false, sourceAnchorCellId: null },
      { cellId: "v2", hasSource: true, hasTarget: true, sourceAnchorCellId: "v1" },
      { cellId: "v3", hasSource: false, hasTarget: true, sourceAnchorCellId: null },
    ])
  })

  it("pages forward on the cell_id cursor without splitting a cell's two sides", async () => {
    t = await makeTestDb({
      cells: [
        cell({ cell_id: "a", side: "source" }),
        cell({ cell_id: "a", side: "target" }),
        cell({ cell_id: "b", side: "source" }),
        cell({ cell_id: "b", side: "target" }),
      ],
    })

    const first = (await (await handleMigrateCellIdsRequest(
      req("projectId=proj-a&fileId=file-x&limit=1"),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    ))!.json()) as CellsBody
    // One CELL, both its sides — never a half-cell page.
    expect(first.cells).toEqual([{ cellId: "a", hasSource: true, hasTarget: true, sourceAnchorCellId: null }])
    expect(first.more).toBe(true)
    expect(first.lastCellId).toBe("a")

    const second = (await (await handleMigrateCellIdsRequest(
      req(`projectId=proj-a&fileId=file-x&limit=1&after=${first.lastCellId}`),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    ))!.json()) as CellsBody
    expect(second.cells).toEqual([{ cellId: "b", hasSource: true, hasTarget: true, sourceAnchorCellId: null }])
  })

  it("rejects a wrong secret, requires projectId + fileId, ignores other paths", async () => {
    const env = { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }
    expect((await handleMigrateCellIdsRequest(req("projectId=proj-a&fileId=file-x", "Bearer no"), env))?.status).toBe(401)
    expect((await handleMigrateCellIdsRequest(req("fileId=file-x"), env))?.status).toBe(400)
    expect((await handleMigrateCellIdsRequest(req("projectId=proj-a"), env))?.status).toBe(400)
    expect(await handleMigrateCellIdsRequest(new Request("https://sync.example/x"), env)).toBeNull()
  })
})
