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

  // The pipelined dispatch runs first-of-signature statements alone and the
  // rest in concurrent waves of ≤100 — this pins that statements still execute
  // in exact array order ACROSS those boundaries, and that results[i] belongs
  // to stmts[i]. Each step RETURNINGs the running value, so any reorder or
  // index mixup changes an assertion, not just the final sum.
  it("preserves order and result indexing across signature warm-ups and wave boundaries", async () => {
    await t.db.exec("CREATE TABLE _bp_seq (id int primary key, v int)")
    await t.db.exec("INSERT INTO _bp_seq (id, v) VALUES (1, 1)")

    const add = "UPDATE _bp_seq SET v = v + ? WHERE id = ? RETURNING v"
    // Modular so ~30 doublings can't overflow int4; still order-sensitive.
    const mul = "UPDATE _bp_seq SET v = (v * ?) % 1000003 WHERE id = ? RETURNING v"
    const stmts = []
    const expected: number[] = []
    let v = 1
    for (let i = 0; i < 230; i++) {
      // Sprinkle the second signature so waves break and resume mid-run.
      const isMul = i % 7 === 3
      stmts.push(t.db.prepare(isMul ? mul : add).bind(isMul ? 2 : 1, 1))
      v = isMul ? (v * 2) % 1000003 : v + 1
      expected.push(v)
    }

    const results = await t.db.batchPipelined!<{ v: number }>(stmts)
    expect(results).toHaveLength(230)
    expect(results.map((r) => Number(r.results[0].v))).toEqual(expected)
    const rows = await t.rows<{ v: number }>("_bp_seq")
    expect(Number(rows[0].v)).toBe(v)
  })
})
