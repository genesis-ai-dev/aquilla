// Test-only: refuse to run more work at once than a request's pool holds.
//
// AQU-2613. Every Worker request gets a Postgres pool of DEFAULT_POOL_MAX
// connections (db/shim/postgres.ts). A statement issued past that pool is what
// wedged an origin connection through Hyperdrive in the 2026-11-13 and
// 2026-11-16 outages (docs/decisions/0011-in-flight-statement-cap.md). The
// PGlite harnesses have no pool, so a route that fans out nine reads in one
// Promise.all passed every test while taking production down.
//
// Production now queues the overflow behind capInFlight, so a wide fan-out no
// longer reaches the driver. This guard sits where that queue would start: it
// throws the moment a unit of work is issued while DEFAULT_POOL_MAX units are
// already in flight, so a route that depends on the queue fails its existing
// tests instead of shipping. A unit is what capInFlight counts: one top-level
// statement or one whole transaction. Statements inside a transaction run on
// the connection it already holds and are not counted.
//
// The count is per executor, and a harness executor is shared by every request
// a test makes. A test that deliberately runs several requests at once can
// raise the limit with `limit` or exempt a block with `withoutPoolGuard`.
// Neither belongs on a test that exercises one request.
import { DEFAULT_POOL_MAX, type PgExecutor } from "../shim/postgres"

export class PoolOverflowError extends Error {
  readonly limit: number
  readonly statement: string
  constructor(limit: number, statement: string) {
    super(
      `More than ${limit} statements in flight at once (DEFAULT_POOL_MAX = ${limit}, one request's ` +
        `Postgres pool). Production would queue this one behind capInFlight; a route that needs ` +
        `that queue is wider than its pool (AQU-2613, docs/decisions/0011-in-flight-statement-cap.md). ` +
        `Read the fan-out in fewer statements or in waves. Statement: ${statement}`,
    )
    this.name = "PoolOverflowError"
    this.limit = limit
    this.statement = statement
  }
}

let suspended = 0
let enabled = true

/** Run `fn` with every pool guard off. For tests that deliberately issue
 *  several requests at once against one shared harness executor. */
export async function withoutPoolGuard<T>(fn: () => Promise<T>): Promise<T> {
  suspended += 1
  try {
    return await fn()
  } finally {
    suspended -= 1
  }
}

/** Turn every pool guard off (or back on) for a whole suite — `beforeAll` /
 *  `afterAll`. Only for a suite whose code under test runs work that holds its
 *  OWN pool in production (a background driver that calls makePostgres) and
 *  therefore shares the harness handle only here. Say which, in a comment, at
 *  the call site. A suite that exercises one request wants the guard on. */
export function setPoolGuardEnabled(next: boolean): void {
  enabled = next
}

function describeStatement(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/** Wrap a harness executor so it throws PoolOverflowError instead of running
 *  a unit of work past `limit` (default DEFAULT_POOL_MAX) in flight. */
export function guardPoolOverflow(executor: PgExecutor, limit = DEFAULT_POOL_MAX): PgExecutor {
  let active = 0
  const hold = async <T>(statement: string, work: () => Promise<T>): Promise<T> => {
    if (enabled && suspended === 0 && active >= limit) throw new PoolOverflowError(limit, statement)
    active += 1
    try {
      return await work()
    } finally {
      active -= 1
    }
  }
  return {
    run: (sql, params, opts) => hold(describeStatement(sql), () => executor.run(sql, params, opts)),
    begin: (fn) => hold("BEGIN (transaction)", () => executor.begin(fn)),
    close: async () => { await executor.close?.() },
  }
}
