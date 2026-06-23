// batchPipelined runs a statement list in ONE transaction, pipelined (no
// per-statement client wait), but MUST preserve send order so dependent
// statements (e.g. deselect-before-upsert in audio projection) still apply in
// order. This is the migrate-ingest fast path — order correctness is the whole
// safety property; the speedup (collapsed network round-trips) is a prod-only
// effect we measure live.
import { describe, it, expect, afterAll } from "vitest"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

let t: TestDb
afterAll(async () => {
  await t?.close()
})

describe("batchPipelined", () => {
  it("preserves order and returns one result per statement", async () => {
    t = await makeTestDb()
    await t.db.exec("CREATE TABLE _bp (id int primary key, v int)")
    const insert = t.db.prepare("INSERT INTO _bp (id, v) VALUES (?, ?)").bind(1, 10)
    const update = t.db.prepare("UPDATE _bp SET v = ? WHERE id = ?").bind(99, 1)

    const results = await t.db.batchPipelined!([insert, update])
    expect(results).toHaveLength(2)

    // The UPDATE ran AFTER the INSERT (order preserved) → v is 99, not absent/10.
    const rows = await t.rows<{ id: number; v: number }>("_bp")
    expect(rows).toEqual([{ id: 1, v: 99 }])
  })

  it("rolls back the whole batch if one statement fails", async () => {
    await t.db.exec("DELETE FROM _bp")
    const good = t.db.prepare("INSERT INTO _bp (id, v) VALUES (?, ?)").bind(2, 1)
    const dup = t.db.prepare("INSERT INTO _bp (id, v) VALUES (?, ?)").bind(2, 2) // PK conflict
    await expect(t.db.batchPipelined!([good, dup])).rejects.toBeTruthy()
    const rows = await t.rows<{ id: number }>("_bp")
    expect(rows).toEqual([]) // neither row persisted
  })
})
