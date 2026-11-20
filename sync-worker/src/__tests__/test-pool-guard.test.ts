// AQU-2613: the worker test harnesses refuse a request that asks for more
// statements at once than its Postgres pool holds
// (db/shared/test-pool-guard.ts). These pin the guard itself; every route test
// exercises it through makeTestDb() and the auth-worker env.
import { describe, it, expect } from "vitest"

import { DEFAULT_POOL_MAX, type AquillaDb } from "../../../db/shim/postgres"
import { guardPoolOverflow, PoolOverflowError, withoutPoolGuard } from "../../../db/shared/test-pool-guard"
import { makeTestDb } from "./helpers/pg-test-db"

/** A handle whose statements answer only when the test releases them. */
function heldDb() {
  const release: Array<() => void> = []
  const result = { results: [], success: true as const, meta: {} }
  const statement = {
    _sql: () => "SELECT held",
    bind: () => statement,
    all: () => new Promise((ok) => release.push(() => ok(result))),
    first: () => new Promise((ok) => release.push(() => ok(null))),
    run: () => new Promise((ok) => release.push(() => ok(result))),
  }
  const db = {
    prepare: (_sql: string) => statement,
    batch: (_statements: unknown[]) => new Promise((ok) => release.push(() => ok([result]))),
  }
  return { db, releaseAll: () => release.splice(0).forEach((r) => r()) }
}

describe("worker tests fail a request wider than its pool (AQU-2613)", () => {
  it("fails the statement past DEFAULT_POOL_MAX, naming the limit and the statement", async () => {
    const { db, releaseAll } = heldDb()
    const guarded = guardPoolOverflow(db)
    const inPool = Array.from({ length: DEFAULT_POOL_MAX }, () => guarded.prepare("SELECT 1").all())
    const err = await guarded.prepare("SELECT 1").all().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PoolOverflowError)
    expect((err as PoolOverflowError).limit).toBe(DEFAULT_POOL_MAX)
    expect((err as Error).message).toContain(`More than ${DEFAULT_POOL_MAX} statements in flight`)
    expect((err as Error).message).toContain("SELECT held")
    releaseAll()
    await Promise.all(inPool)
  })

  it("lets a fan-out of exactly the pool through, and frees slots as statements answer", async () => {
    const { db, releaseAll } = heldDb()
    const guarded = guardPoolOverflow(db)
    const first = Array.from({ length: DEFAULT_POOL_MAX }, () => guarded.prepare("SELECT 1").all())
    releaseAll()
    await Promise.all(first)
    const second = Array.from({ length: DEFAULT_POOL_MAX }, () => guarded.prepare("SELECT 1").all())
    releaseAll()
    await expect(Promise.all(second)).resolves.toHaveLength(DEFAULT_POOL_MAX)
  })

  it("counts a batch as one connection, however many statements it carries", async () => {
    const { db, releaseAll } = heldDb()
    const guarded = guardPoolOverflow(db, 1)
    const batched = guarded.batch(Array.from({ length: DEFAULT_POOL_MAX + 3 }, () => guarded.prepare("SELECT 1")))
    releaseAll()
    await expect(batched).resolves.toHaveLength(1)
  })

  it("withoutPoolGuard exempts a block that deliberately runs several requests at once", async () => {
    const { db, releaseAll } = heldDb()
    const guarded = guardPoolOverflow(db)
    const all = withoutPoolGuard(() => {
      const wide = Array.from({ length: DEFAULT_POOL_MAX + 2 }, () => guarded.prepare("SELECT 1").all())
      releaseAll()
      return Promise.all(wide)
    })
    await expect(all).resolves.toHaveLength(DEFAULT_POOL_MAX + 2)
  })

  it("is on in the shared harness: a Promise.all past the pool fails against makeTestDb()", async () => {
    const t = await makeTestDb()
    try {
      const db: AquillaDb = t.db
      const read = (n: number) => db.prepare(`SELECT ${n} AS n`).first<{ n: number }>()
      const wide = Array.from({ length: DEFAULT_POOL_MAX + 1 }, (_, i) => read(i))
      const settled = await Promise.allSettled(wide)
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected")
      expect(rejected).toHaveLength(1)
      expect(rejected[0].reason).toBeInstanceOf(PoolOverflowError)
      const narrow = Array.from({ length: DEFAULT_POOL_MAX }, (_, i) => read(i))
      await expect(Promise.all(narrow)).resolves.toHaveLength(DEFAULT_POOL_MAX)
    } finally {
      await t.close()
    }
  })
})
