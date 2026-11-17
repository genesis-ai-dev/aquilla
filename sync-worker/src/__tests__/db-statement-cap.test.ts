// Production outages 2026-11-13 and 2026-11-16 (docs/decisions/0011-in-flight-statement-cap.md).
//
// A request has a pool of DEFAULT_POOL_MAX connections. A statement issued
// past that had no connection of its own, and through Hyperdrive one such
// statement was left half-sent: it held an origin connection for ten minutes,
// and enough of them left no connection for any route. The handle therefore
// never gives the driver more work than it has connections for.
//
// Hyperdrive is the only place the wedge happens, so none of this can show
// the wedge itself. What it pins is the property that prevents it: how many
// units of work the driver holds at once.
import { describe, it, expect } from "vitest"
import type postgres from "postgres"

import {
  capInFlight,
  fromPostgresJs,
  pgDriverOptions,
  PostgresDb,
  DEFAULT_POOL_MAX,
  MAX_PIPELINE,
  type PgExecutor,
} from "../../../db/shim/postgres"

/** Let every promise that can settle, settle. */
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

/** An executor whose statements finish only when the test says so. */
function manual() {
  const state = { inFlight: 0, peak: 0, started: [] as string[] }
  const finish = new Map<string, { ok: () => void; fail: (e: Error) => void }>()
  const run: PgExecutor["run"] = async (sql) => {
    state.inFlight += 1
    state.peak = Math.max(state.peak, state.inFlight)
    state.started.push(sql)
    try {
      await new Promise<void>((ok, fail) => finish.set(sql, { ok, fail }))
      return { rows: [{ sql }], rowCount: 1 }
    } finally {
      state.inFlight -= 1
    }
  }
  const exec: PgExecutor = {
    run,
    // A transaction is one connection for as long as its body runs.
    async begin(fn) {
      state.inFlight += 1
      state.peak = Math.max(state.peak, state.inFlight)
      try {
        return await fn({ run: async (sql) => { state.started.push(sql); return { rows: [], rowCount: 0 } }, begin: exec.begin })
      } finally {
        state.inFlight -= 1
      }
    },
  }
  return { exec, state, finish }
}

describe("a handle never holds more work than its pool has connections", () => {
  it("runs the surplus only as earlier statements finish, and every one still answers", async () => {
    const { exec, state, finish } = manual()
    const db = capInFlight(exec, 3)
    const names = ["a", "b", "c", "d", "e", "f", "g"]
    const all = Promise.all(names.map((n) => db.run(n, [])))
    await settle()
    expect(state.started).toEqual(["a", "b", "c"])

    for (const n of names) {
      finish.get(n)!.ok()
      await settle()
    }
    expect((await all).map((r) => r.rows[0].sql)).toEqual(names)
    expect(state.peak).toBe(3)
  })

  it("serves waiters in the order they were issued", async () => {
    const { exec, state, finish } = manual()
    const db = capInFlight(exec, 1)
    const all = Promise.all(["first", "second", "third"].map((n) => db.run(n, [])))
    await settle()
    finish.get("first")!.ok()
    await settle()
    // A statement issued now must not overtake the two already waiting.
    const late = db.run("late", [])
    await settle()
    expect(state.started).toEqual(["first", "second"])
    for (const n of ["second", "third", "late"]) {
      finish.get(n)!.ok()
      await settle()
    }
    await Promise.all([all, late])
    expect(state.started).toEqual(["first", "second", "third", "late"])
  })

  it("gives the slot back when a statement fails", async () => {
    const { exec, state, finish } = manual()
    const db = capInFlight(exec, 1)
    const failing = db.run("boom", [])
    const next = db.run("after", [])
    await settle()
    finish.get("boom")!.fail(new Error("statement timeout"))
    await expect(failing).rejects.toThrow("statement timeout")
    await settle()
    // A leaked slot here would hang every later statement on the request.
    expect(state.started).toEqual(["boom", "after"])
    finish.get("after")!.ok()
    await next
  })

  it("counts a transaction as one unit, and the statements inside it as none", async () => {
    const { exec, state } = manual()
    const db = capInFlight(exec, 1)
    // With a cap of one, a transaction whose own statements needed a slot
    // would wait on itself forever.
    await db.begin(async (tx) => {
      await tx.run("inside-1", [])
      await tx.run("inside-2", [])
    })
    expect(state.started).toEqual(["inside-1", "inside-2"])
    expect(state.peak).toBe(1)
  })
})

describe("the production executor is built with the cap", () => {
  // The cap is worthless if the handle the workers use is built without it.
  it("hands the driver at most its pool size when a route issues more", async () => {
    const driver = { inFlight: 0, peak: 0, release: [] as Array<() => void> }
    const sql = {
      unsafe: async () => {
        driver.inFlight += 1
        driver.peak = Math.max(driver.peak, driver.inFlight)
        await new Promise<void>((resolve) => driver.release.push(resolve))
        driver.inFlight -= 1
        return []
      },
    } as unknown as postgres.Sql
    const db = new PostgresDb(fromPostgresJs(sql, DEFAULT_POOL_MAX))
    const wide = DEFAULT_POOL_MAX + 5
    const all = Promise.all(
      Array.from({ length: wide }, (_, i) => db.prepare("SELECT ?").bind(i).all()),
    )
    await settle()
    expect(driver.inFlight).toBe(DEFAULT_POOL_MAX)
    while (driver.release.length) {
      driver.release.shift()!()
      await settle()
    }
    expect(await all).toHaveLength(wide)
    expect(driver.peak).toBe(DEFAULT_POOL_MAX)
  })
})

// postgres.js 4 writes a statement to a BUSY connection where postgres.js 3
// queued it. These pin the two places the shim refuses to let that happen.
describe("the driver never has two unprepared statements on one connection", () => {
  it("builds every production handle with a pipeline of one", () => {
    expect(MAX_PIPELINE).toBe(1)
    expect(pgDriverOptions(DEFAULT_POOL_MAX).max_pipeline).toBe(1)
    // The pool the cap is sized to, and the rest of what the handle needs.
    expect(pgDriverOptions(DEFAULT_POOL_MAX)).toMatchObject({ max: DEFAULT_POOL_MAX, fetch_types: false })
  })

  /** A driver whose transaction records what it was handed, and when. */
  function transactionDriver() {
    // `open` is in the order the driver was handed them: several statements
    // may share one SQL text (a prepared wave), so they are not keyed by it.
    const tx = { inFlight: 0, peak: 0, sent: [] as string[], open: [] as Array<{ ok: () => void; fail: (e: Error) => void }> }
    const unsafe = async (query: string) => {
      tx.inFlight += 1
      tx.peak = Math.max(tx.peak, tx.inFlight)
      tx.sent.push(query)
      try {
        await new Promise<void>((ok, fail) => tx.open.push({ ok, fail }))
        return []
      } finally {
        tx.inFlight -= 1
      }
    }
    const sql = {
      begin: (fn: (t: unknown) => Promise<unknown>) => fn({ unsafe }),
    } as unknown as postgres.Sql
    return { sql, tx }
  }

  it("holds a Promise.all inside a transaction to one statement at a time, in order", async () => {
    const { sql, tx } = transactionDriver()
    const db = new PostgresDb(fromPostgresJs(sql, DEFAULT_POOL_MAX))
    const done = db.transaction((t) =>
      Promise.all(["SELECT 'a'", "SELECT 'b'", "SELECT 'c'"].map((q) => t.prepare(q).all())),
    )
    await settle()
    expect(tx.sent).toEqual(["SELECT 'a'"])
    for (let i = 0; i < 3; i++) {
      tx.open.shift()!.ok()
      await settle()
    }
    expect(await done).toHaveLength(3)
    expect(tx.sent).toEqual(["SELECT 'a'", "SELECT 'b'", "SELECT 'c'"])
    expect(tx.peak).toBe(1)
  })

  it("still sends the statement behind one that failed", async () => {
    const { sql, tx } = transactionDriver()
    const db = new PostgresDb(fromPostgresJs(sql, DEFAULT_POOL_MAX))
    const outcome = db.transaction((t) =>
      Promise.allSettled([t.prepare("SELECT 'boom'").all(), t.prepare("SELECT 'after'").all()]),
    )
    await settle()
    tx.open.shift()!.fail(new Error("duplicate key"))
    await settle()
    // Left unsent, it would never settle and the transaction would never end.
    expect(tx.sent).toEqual(["SELECT 'boom'", "SELECT 'after'"])
    tx.open.shift()!.ok()
    expect((await outcome).map((r) => r.status)).toEqual(["rejected", "fulfilled"])
  })

  it("leaves batchPipelined's prepared waves dispatched together", async () => {
    const { sql, tx } = transactionDriver()
    const db = new PostgresDb(fromPostgresJs(sql, DEFAULT_POOL_MAX))
    const stmts = [1, 2, 3, 4].map((n) => db.prepare("INSERT INTO t VALUES (?)").bind(n))
    const done = db.batchPipelined(stmts)
    await settle()
    // The first of a shape runs alone, to prepare it.
    expect(tx.inFlight).toBe(1)
    tx.open.shift()!.ok()
    await settle()
    // The rest are written to the connection before any answer is read.
    expect(tx.inFlight).toBe(3)
    while (tx.open.length) {
      tx.open.shift()!.ok()
      await settle()
    }
    expect(await done).toHaveLength(4)
  })
})
