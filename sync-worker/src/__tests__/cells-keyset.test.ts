/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vitest"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import { fetchFileCells, fetchCellsDelta } from "../../../src/lib/sync/cells-read"

const secret = "scan-test-secret"
let testDb: TestDb | undefined
afterEach(async () => { vi.unstubAllGlobals(); await testDb?.close(); testDb = undefined })

function cell(id: string, side = "source", target_lang = "") {
  return { project_id: "p", file_id: "f", cell_id: id, side, target_lang,
    value: id, event_id: `e-${id}`, last_edit_at: 0, anchor_cell_id: null }
}
function event(id: string, cell_id: string, server_seq: number) {
  return { id, project_id: "p", file_id: "f", cell_id, server_seq,
    kind: "source.cell.commit", payload: "{}", schema_version: 1, author: "alice", client_ts: 0, server_ts: 0 }
}
async function setup() {
  testDb = await makeTestDb({
    cells: [cell("a"), cell("b"), cell("c"), cell("d")],
    events: [event("old", "a", 10), event("fast", "c", 12)],
    project_seq_counters: [{ project_id: "p", last_seq: 12, project_epoch: 1, rebuilt_seq: 0 }],
    seq_allocations: [{ project_id: "p", first_seq: 11, last_seq: 11 }],
  })
  const db = testDb.db
  const queries: string[] = []
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, "prepare").mockImplementation((sql) => { queries.push(sql); return prepare(sql) })
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const res = await handleCellsReadRequest(new Request(url, init), { AQUILLA_PG: db, SYNC_SECRET_KEY: secret })
    if (!res) throw new Error("unhandled route")
    return res
  })
  const token = await makeTestToken(secret, { projectId: "p", fileId: "f" })
  return { db, token, queries }
}

describe("bounded keyset producer -> real SPA read consumer", () => {
  it("keeps the first safe cursor as the fast/slow gap closes; deletion cannot skip an unchanged row", async () => {
    const { db, token, queries } = await setup()
    const first = await fetchFileCells("p", "f", { side: "source", limit: 2, pagination: "keyset" }, token)
    expect(first.cells.map((r) => r.cellId)).toEqual(["a", "b"])
    expect(first.maxServerSeq).toBe(10)
    expect(first.pagination).toBe("keyset")
    // A preceding row disappears and a new row is inserted behind the cursor
    // while the stalled writer settles. Offset pagination would skip c.
    await db.prepare("DELETE FROM cells WHERE cell_id = ?").bind("a").run()
    await db.prepare("DELETE FROM seq_allocations WHERE project_id = ?").bind("p").run()
    await db.prepare("INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind("p", "f", "aa", "source", "new", "new", 1).run()
    await db.prepare("INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("late", 1, "p", "f", "a", "source.cell.commit", "alice", "{}", 0, 0, 11).run()
    await db.prepare("INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("new", 1, "p", "f", "aa", "source.cell.create", "alice", "{}", 0, 0, 13).run()
    const second = await fetchFileCells("p", "f", { side: "source", limit: 2, pagination: "keyset", cursor: first.nextCursor! }, token)
    expect(second.cells.map((r) => r.cellId)).toEqual(["c", "d"])
    expect(second.nextCursor).toBeNull()
    expect(second.maxServerSeq).toBe(10)
    const pageQueries = queries.filter((q) => q.startsWith("SELECT cell_id"))
    expect(pageQueries).toHaveLength(2)
    expect(pageQueries.every((q) => q.endsWith("ORDER BY side, target_lang, cell_id LIMIT ?"))).toBe(true)
    expect(queries.filter((q) => q.startsWith("SELECT COUNT(*)"))).toHaveLength(1)

    const delta = await fetchCellsDelta("p", "f", first.maxServerSeq!, token, undefined, first.projectEpoch)
    expect(delta.kind).toBe("delta")
    if (delta.kind !== "delta") throw new Error("expected delta")
    expect(delta.changedCellIds).toEqual(expect.arrayContaining(["a", "aa", "c"]))
    expect(delta.cells.some((r) => r.cellId === "a")).toBe(false)
    expect(delta.cells.find((r) => r.cellId === "aa")?.value).toBe("new")
    expect(delta.maxServerSeq).toBe(13)
  })

  it("rejects cross-file cursors and a changed project incarnation", async () => {
    const { db, token } = await setup()
    const first = await fetchFileCells("p", "f", { pagination: "keyset", limit: 1 }, token)
    await expect(fetchFileCells("p", "other", { pagination: "keyset", cursor: first.nextCursor! }, token)).rejects.toMatchObject({ status: 400 })
    await db.prepare("UPDATE project_seq_counters SET project_epoch = 2 WHERE project_id = ?").bind("p").run()
    await expect(fetchFileCells("p", "f", { pagination: "keyset", cursor: first.nextCursor! }, token)).rejects.toMatchObject({ status: 409 })
  })

  it("pages every lane without dropping rows sharing a cell id", async () => {
    const { db, token } = await setup()
    for (const lane of ["", "fr"]) {
      await db.prepare("INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind("p", "f", "b", "target", lane, "target", `t-${lane}`, 0).run()
    }
    const first = await fetchFileCells("p", "f", { side: "target", pagination: "keyset", limit: 1 }, token)
    const second = await fetchFileCells("p", "f", { side: "target", pagination: "keyset", limit: 1, cursor: first.nextCursor! }, token)
    expect([first.cells[0].targetLang, second.cells[0].targetLang]).toEqual(["", "fr"])
    expect(second.nextCursor).toBeNull()
  })
})
