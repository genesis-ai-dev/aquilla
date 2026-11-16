// AQU-2613: the worker test harnesses refuse a request that has more
// statements in flight than its Postgres pool holds (db/shared/test-pool-guard.ts).
// These pin the guard itself; every route test exercises it through
// makeTestDb() and the auth-worker env.
import { describe, it, expect } from "vitest"

import { DEFAULT_POOL_MAX, PostgresDb, type PgExecutor } from "../../../db/shim/postgres"
import { guardPoolOverflow, PoolOverflowError, withoutPoolGuard } from "../../../db/shared/test-pool-guard"
import { makeTestDb } from "./helpers/pg-test-db"

/** An executor whose statements finish only when the test releases them. */
function held() {
  const release: Array<() => void> = []
  const exec: PgExecutor = {
    run: (sql) => new Promise((ok) => release.push(() => ok({ rows: [{ sql }], rowCount: 1 }))),
    begin: (fn) => fn({ run: async () => ({ rows: [], rowCount: 0 }), begin: exec.begin }),
  }
  return { exec, releaseAll: () => release.splice(0).forEach((r) => r()) }
}

describe("worker tests fail a request wider than its pool (AQU-2613)", () => {
  it("throws on the statement past DEFAULT_POOL_MAX, naming the limit and the statement", async () => {
    const { exec, releaseAll } = held()
    const db = guardPoolOverflow(exec)
    const inPool = Array.from({ length: DEFAULT_POOL_MAX }, (_, i) => db.run(`SELECT ${i}`, []))
    const err = await db.run("SELECT   overflow\n  FROM t", []).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PoolOverflowError)
    expect((err as PoolOverflowError).limit).toBe(DEFAULT_POOL_MAX)
    expect((err as Error).message).toContain(`More than ${DEFAULT_POOL_MAX} statements in flight`)
    expect((err as Error).message).toContain("SELECT overflow FROM t")
    releaseAll()
    await Promise.all(inPool)
  })

  it("lets a fan-out of exactly the pool through, and frees slots as statements finish", async () => {
    const { exec, releaseAll } = held()
    const db = guardPoolOverflow(exec)
    const first = Array.from({ length: DEFAULT_POOL_MAX }, (_, i) => db.run(`SELECT ${i}`, []))
    releaseAll()
    await Promise.all(first)
    const second = Array.from({ length: DEFAULT_POOL_MAX }, (_, i) => db.run(`SELECT ${i}`, []))
    releaseAll()
    await expect(Promise.all(second)).resolves.toHaveLength(DEFAULT_POOL_MAX)
  })

  it("counts a transaction as one connection, not each statement inside it", async () => {
    const { exec } = held()
    const db = guardPoolOverflow(exec, 1)
    await expect(db.begin(async (tx) => {
      await Promise.all(Array.from({ length: DEFAULT_POOL_MAX + 3 }, () => tx.run("SELECT 1", [])))
      return "ok"
    })).resolves.toBe("ok")
  })

  it("withoutPoolGuard exempts a block that deliberately runs several requests at once", async () => {
    const { exec, releaseAll } = held()
    const db = guardPoolOverflow(exec)
    const all = withoutPoolGuard(async () => {
      const wide = Array.from({ length: DEFAULT_POOL_MAX + 2 }, (_, i) => db.run(`SELECT ${i}`, []))
      releaseAll()
      return Promise.all(wide)
    })
    await expect(all).resolves.toHaveLength(DEFAULT_POOL_MAX + 2)
  })

  it("is on in the shared harness: a Promise.all past the pool fails against makeTestDb()", async () => {
    const t = await makeTestDb()
    try {
      const db = t.db as unknown as PostgresDb
      const wide = Array.from({ length: DEFAULT_POOL_MAX + 1 }, (_, i) => db.prepare(`SELECT ${i} AS n`).first())
      const results = await Promise.allSettled(wide)
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
      expect(rejected).toHaveLength(1)
      expect(rejected[0].reason).toBeInstanceOf(PoolOverflowError)
      const narrow = Array.from({ length: DEFAULT_POOL_MAX }, (_, i) => db.prepare(`SELECT ${i} AS n`).first())
      await expect(Promise.all(narrow)).resolves.toHaveLength(DEFAULT_POOL_MAX)
    } finally {
      await t.close()
    }
  })
})
