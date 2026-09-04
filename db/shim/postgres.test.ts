// Isolate-level pool + prepare gate (db/shim/postgres.ts).
//
// Why these matter: the workers used to build a postgres.js client per
// request and close it in ctx.waitUntil, which meant (a) the statement cache
// never warmed so `prepare` bought nothing, and (b) a pool was acquired on
// every request. getPostgres() must hand back ONE handle per connection
// string that the request path can never close, and the prepare gate must
// stay bounded so prod's ~280 row-count-generated INSERT variants cannot
// grow an unbounded set of server-side statements.
import { describe, it, expect, beforeEach } from "vitest"
import {
  getPostgres,
  makePostgres,
  shouldPrepare,
  resetPrepareRegistry,
  PREPARE_MAX_SQL_LENGTH,
  PREPARE_MAX_STATEMENTS,
} from "./postgres"

// postgres.js dials lazily, so constructing clients against a bogus host is
// side-effect free until a query runs.
const CS_A = "postgres://user:pw@127.0.0.1:1/aquilla_a"
const CS_B = "postgres://user:pw@127.0.0.1:1/aquilla_b"

describe("getPostgres — isolate-level pool", () => {
  it("returns the same handle for the same connection string, distinct per string", () => {
    const a1 = getPostgres(CS_A)
    const a2 = getPostgres(CS_A)
    const b = getPostgres(CS_B)
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
  })

  it("close() on the shared handle is a no-op — the pool survives the request path", async () => {
    const shared = getPostgres(CS_A)
    await expect(shared.close()).resolves.toBeUndefined()
    // Still the same live handle afterwards: nothing was torn down.
    expect(getPostgres(CS_A)).toBe(shared)
  })

  it("makePostgres() still builds an owned handle the caller can close", async () => {
    const owned = makePostgres(CS_B)
    expect(owned).not.toBe(getPostgres(CS_B))
    await expect(owned.close()).resolves.toBeUndefined()
  })
})

describe("shouldPrepare — bounded named-statement gate", () => {
  beforeEach(() => resetPrepareRegistry())

  it("prepares short parameterised SQL and remembers it", () => {
    const reg = new Set<string>()
    expect(shouldPrepare("SELECT * FROM cells WHERE id = $1", 1, reg)).toBe(true)
    expect(shouldPrepare("SELECT * FROM cells WHERE id = $1", 1, reg)).toBe(true)
    expect(reg.size).toBe(1)
  })

  it("never prepares statements with no parameters (nothing to Describe)", () => {
    const reg = new Set<string>()
    expect(shouldPrepare("SELECT 1", 0, reg)).toBe(false)
    expect(reg.size).toBe(0)
  })

  it("refuses SQL longer than the length cap (row-count-generated INSERT variants)", () => {
    const reg = new Set<string>()
    const values = Array.from({ length: 400 }, (_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(",")
    const sql = `INSERT INTO cells (a,b,c) VALUES ${values}`
    expect(sql.length).toBeGreaterThan(PREPARE_MAX_SQL_LENGTH)
    expect(shouldPrepare(sql, 1200, reg)).toBe(false)
    expect(reg.size).toBe(0)
  })

  it("stops admitting new texts once the registry is full, but keeps serving admitted ones", () => {
    const reg = new Set<string>()
    for (let i = 0; i < PREPARE_MAX_STATEMENTS; i++) {
      expect(shouldPrepare(`SELECT ${i} WHERE $1`, 1, reg)).toBe(true)
    }
    expect(reg.size).toBe(PREPARE_MAX_STATEMENTS)
    expect(shouldPrepare("SELECT 'overflow' WHERE $1", 1, reg)).toBe(false)
    expect(reg.size).toBe(PREPARE_MAX_STATEMENTS)
    expect(shouldPrepare("SELECT 0 WHERE $1", 1, reg)).toBe(true)
  })

  it("uses the module registry by default", () => {
    expect(shouldPrepare("SELECT $1", 1)).toBe(true)
    resetPrepareRegistry()
    // Fresh registry admits it again rather than treating it as known.
    expect(shouldPrepare("SELECT $1", 1)).toBe(true)
  })
})
