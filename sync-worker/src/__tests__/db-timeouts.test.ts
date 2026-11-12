// AQU-1876 — connection-level statement / idle-in-transaction timeouts.
//
// Two things are worth pinning here, and neither can be pinned with PGlite:
// the WASM build does not enforce statement_timeout (it has no timer interrupt,
// so `SET LOCAL statement_timeout = 300` + `pg_sleep(3)` returns after 3s).
// Actual cancellation is therefore a dev-stack check — that is what
// GET /admin/db/timeouts?sleep=N exists for.
//
// What IS pinned here:
//   1. the values that go onto every connection, and the exact statement a
//      long-operation opt-out sends (a timeout that never reaches Postgres is
//      a no-op nothing else in the system would notice);
//   2. the opt-out registry's shape — an entry that does not actually raise the
//      ceiling is a bug, and the registry is the one list reviewers read.
import { describe, it, expect } from "vitest"
import {
  PostgresDb,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  LONG_OPERATION_TIMEOUTS,
  pgTimeoutConnectionParams,
  withLongOperationTimeout,
  type PgExecutor,
} from "../../../db/shim/postgres"
import { handleDbTimeoutsRequest } from "../db-timeouts-route"

/** Recording executor: captures every statement, and whether it ran inside a
 *  transaction, without needing a database. */
function recorder() {
  const sent: Array<{ sql: string; inTx: boolean }> = []
  let depth = 0
  const exec: PgExecutor = {
    async run(sql) {
      sent.push({ sql, inTx: depth > 0 })
      return { rows: [], rowCount: 0 }
    },
    async begin(fn) {
      depth++
      try {
        return await fn(exec)
      } finally {
        depth--
      }
    },
  }
  return { exec, sent, sql: () => sent.map((s) => s.sql) }
}

describe("connection timeout defaults", () => {
  it("puts both ceilings on every connection as stringified ms", () => {
    expect(pgTimeoutConnectionParams()).toEqual({
      statement_timeout: String(DEFAULT_STATEMENT_TIMEOUT_MS),
      idle_in_transaction_session_timeout: String(DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS),
    })
  })

  it("honours explicit overrides", () => {
    expect(pgTimeoutConnectionParams({ statementTimeoutMs: 1234 }).statement_timeout).toBe("1234")
  })

  it("omits a parameter set to null (no ceiling)", () => {
    const params = pgTimeoutConnectionParams({
      statementTimeoutMs: null,
      idleInTransactionTimeoutMs: null,
    })
    expect(params).toEqual({})
  })
})

describe("LONG_OPERATION_TIMEOUTS registry", () => {
  it("every opt-out actually raises the ceiling it opts out of", () => {
    for (const [op, ms] of Object.entries(LONG_OPERATION_TIMEOUTS)) {
      expect(ms, `${op} must exceed the request-path default to be an opt-out`)
        .toBeGreaterThan(DEFAULT_STATEMENT_TIMEOUT_MS)
    }
  })

  it("every opt-out is a positive integer number of ms", () => {
    for (const ms of Object.values(LONG_OPERATION_TIMEOUTS)) {
      expect(Number.isInteger(ms)).toBe(true)
      expect(ms).toBeGreaterThan(0)
    }
  })
})

describe("withStatementTimeout", () => {
  it("sends nothing extra on an ordinary handle, and stays out of a transaction", async () => {
    const { exec, sent } = recorder()
    await new PostgresDb(exec).prepare("SELECT 1").run()
    expect(sent).toEqual([{ sql: "SELECT 1", inTx: false }])
  })

  it("sets the ceiling transaction-locally before the query", async () => {
    const { exec, sent, sql } = recorder()
    await new PostgresDb(exec).withStatementTimeout(120_000).prepare("SELECT 1").run()
    expect(sql()).toEqual(["SET LOCAL statement_timeout = 120000", "SELECT 1"])
    // SET LOCAL only takes effect inside a transaction — and being transaction
    // local is what stops it leaking to the next request on this connection.
    expect(sent.every((s) => s.inTx)).toBe(true)
  })

  it("keeps the identity SET LOCAL alongside it", async () => {
    const { exec, sql } = recorder()
    await new PostgresDb(exec).withUser(42).withStatementTimeout(60_000).prepare("SELECT 1").run()
    expect(sql()).toEqual([
      "SET LOCAL app.user_id = '42'",
      "SET LOCAL statement_timeout = 60000",
      "SELECT 1",
    ])
  })

  it("survives asAdmin() and withUser() re-derivation", async () => {
    const { exec, sql } = recorder()
    await new PostgresDb(exec).withStatementTimeout(60_000).asAdmin().prepare("SELECT 1").run()
    expect(sql()).toEqual([
      "SET LOCAL app.user_id = ''",
      "SET LOCAL statement_timeout = 60000",
      "SELECT 1",
    ])
  })

  it("sets the ceiling once per batch, not once per statement", async () => {
    const { exec, sql } = recorder()
    const db = new PostgresDb(exec).withStatementTimeout(120_000)
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")])
    expect(sql()).toEqual(["SET LOCAL statement_timeout = 120000", "SELECT 1", "SELECT 2"])
  })

  it("rejects a value that is not a positive integer", () => {
    const { exec } = recorder()
    const db = new PostgresDb(exec)
    // SET LOCAL takes no bind parameter, so the value is interpolated into SQL:
    // this guard is the gate between a caller and a GUC-injection primitive.
    expect(() => db.withStatementTimeout(0)).toThrow(/positive integer/)
    expect(() => db.withStatementTimeout(-1)).toThrow(/positive integer/)
    expect(() => db.withStatementTimeout(1.5)).toThrow(/positive integer/)
    expect(() => db.withStatementTimeout("15000; DROP TABLE cells" as unknown as number))
      .toThrow(/positive integer/)
  })
})

describe("withLongOperationTimeout", () => {
  it("applies the registered ceiling for the named operation", async () => {
    const { exec, sql } = recorder()
    await withLongOperationTimeout(new PostgresDb(exec), "import-finalize")
      .prepare("SELECT 1")
      .run()
    expect(sql()).toEqual([
      `SET LOCAL statement_timeout = ${LONG_OPERATION_TIMEOUTS["import-finalize"]}`,
      "SELECT 1",
    ])
  })

  it("returns the handle unchanged when the executor has no per-handle timeouts", () => {
    const double = { prepare: () => { throw new Error("unused") } } as unknown as AquillaDb
    expect(withLongOperationTimeout(double, "project-rebuild")).toBe(double)
  })
})

// ─── GET /admin/db/timeouts — the dev-stack verification affordance ──────────

const IN_FORCE = { statement_timeout: "15s", idle_in_transaction_session_timeout: "30s" }

function probeDb(onSleep?: () => never) {
  return {
    prepare(sql: string) {
      return {
        bind: () => { throw new Error("unused") },
        all: async () => ({ results: [], success: true as const }),
        run: async () => {
          if (sql.includes("pg_sleep")) onSleep?.()
          return { results: [], success: true as const }
        },
        first: async () => (sql.includes("current_setting") ? IN_FORCE : null),
        raw: async () => [],
      }
    },
  } as unknown as AquillaDb
}

const ENV = { AQUILLA_PG: probeDb(), ADMIN_SECRET: "s3cret", ENVIRONMENT: "development" }
const AUTHED = { Authorization: "Bearer s3cret" }
const URL_BASE = "https://sync.example/admin/db/timeouts"

describe("GET /admin/db/timeouts", () => {
  it("falls through for any other path", async () => {
    expect(await handleDbTimeoutsRequest(new Request("https://sync.example/other"), ENV)).toBeNull()
  })

  it("401s without the admin bearer", async () => {
    const res = await handleDbTimeoutsRequest(new Request(URL_BASE), ENV)
    expect(res?.status).toBe(401)
  })

  it("500s when no admin credential is bound (fails closed)", async () => {
    const res = await handleDbTimeoutsRequest(new Request(URL_BASE, { headers: AUTHED }), {
      AQUILLA_PG: probeDb(),
    })
    expect(res?.status).toBe(500)
  })

  it("reports what Postgres says is in force on the connection", async () => {
    const res = await handleDbTimeoutsRequest(new Request(URL_BASE, { headers: AUTHED }), ENV)
    expect(res?.status).toBe(200)
    expect(await res!.json()).toEqual({ ok: true, inForce: IN_FORCE })
  })

  it("reports a cancelled slow query, with its SQLSTATE", async () => {
    const env = {
      ...ENV,
      AQUILLA_PG: probeDb(() => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        })
      }),
    }
    const res = await handleDbTimeoutsRequest(
      new Request(`${URL_BASE}?sleep=30`, { headers: AUTHED }),
      env,
    )
    expect(res?.status).toBe(200)
    expect(await res!.json()).toMatchObject({ cancelled: true, code: "57014", sleepSeconds: 30 })
  })

  it("flags a slow query that was NOT cancelled — the no-op case this route exists to catch", async () => {
    const res = await handleDbTimeoutsRequest(
      new Request(`${URL_BASE}?sleep=30`, { headers: AUTHED }),
      ENV,
    )
    expect(await res!.json()).toMatchObject({ cancelled: false })
  })

  it("rejects a nonsense or oversized sleep", async () => {
    for (const q of ["0", "-1", "1.5", "abc", "121"]) {
      const res = await handleDbTimeoutsRequest(
        new Request(`${URL_BASE}?sleep=${q}`, { headers: AUTHED }),
        ENV,
      )
      expect(res?.status, q).toBe(400)
    }
  })

  it("refuses the sleep arm on production, but still reports", async () => {
    const prod = { ...ENV, ENVIRONMENT: "production" }
    expect(
      (await handleDbTimeoutsRequest(new Request(`${URL_BASE}?sleep=30`, { headers: AUTHED }), prod))
        ?.status,
    ).toBe(403)
    expect(
      (await handleDbTimeoutsRequest(new Request(URL_BASE, { headers: AUTHED }), prod))?.status,
    ).toBe(200)
  })

  it("405s a non-GET", async () => {
    const res = await handleDbTimeoutsRequest(
      new Request(URL_BASE, { method: "POST", headers: AUTHED }),
      ENV,
    )
    expect(res?.status).toBe(405)
  })
})
