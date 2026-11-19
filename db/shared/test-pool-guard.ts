// Test-only: refuse a request that holds more work at once than its pool has
// connections.
//
// AQU-2613. Every Worker request gets a Postgres pool of DEFAULT_POOL_MAX
// connections (db/shim/postgres.ts). A statement issued past that pool is what
// wedged an origin connection through Hyperdrive in the 2026-11-13 and
// 2026-11-16 outages (docs/decisions/0011-in-flight-statement-cap.md). The
// PGlite harnesses have no pool, so `GET /orgs/:id/settings` fanning nine
// reads out of one Promise.all passed every test while taking production down.
//
// Production now holds the surplus behind capInFlight, so a wide fan-out
// queues instead of wedging. This guard sits where that queue would form: it
// throws the moment a unit of work is ASKED FOR while DEFAULT_POOL_MAX units
// are already outstanding, so a route that depends on the queue fails its
// existing tests instead of shipping.
//
// It counts where the route asks — `all()` / `first()` / `run()` / `raw()` on
// a statement, or one `batch()` / `batchPipelined()` — not where the executor
// dispatches, which is a turn of the event loop later and already a statement
// short. A batch is one transaction on one connection, so it is one unit
// however many statements it carries — the rule capInFlight applies.
//
// What it catches is a fan-out issued before any of it answers, which is the
// shape that took production down. It is not a full model of a pool: PGlite
// answers in microseconds where Hyperdrive takes a round trip, so a statement
// that would still be outstanding in production while the next fan-out goes
// out has often already returned here, and the overlap this sees is the
// floor of the real one. A route that needs its exact peak pinned writes a
// probe of its own — `org-override-projects.test.ts` does.
//
// The count is per handle, and a harness handle serves every request a test
// makes. A test that deliberately runs several requests at once can exempt a
// block with `withoutPoolGuard`, or a suite with `setPoolGuardEnabled(false)`.
// Neither belongs on a test that exercises one request.
import { DEFAULT_POOL_MAX } from "../shim/postgres"

/** Statement methods: each call is one unit of work on one connection. */
const UNIT_METHODS = new Set(["all", "first", "run", "raw", "batch", "batchPipelined"])

/** `_on()` re-binds a statement onto a transaction's executor — the shim does
 *  it for every statement inside a batch. Those run on the connection the
 *  batch already holds, so what it hands back leaves the guard behind: the
 *  batch was counted once, when it was asked for. */
const UNCOUNTED_FROM = new Set(["_on"])

export class PoolOverflowError extends Error {
  readonly limit: number
  readonly statement: string
  constructor(limit: number, statement: string) {
    super(
      `More than ${limit} statements in flight at once (DEFAULT_POOL_MAX = ${limit}, one request's ` +
        `Postgres pool). Production would hold this one behind capInFlight; a route that needs that ` +
        `queue is wider than its pool (AQU-2613, docs/decisions/0011-in-flight-statement-cap.md). ` +
        `Read the fan-out in fewer statements, or in waves. Statement: ${statement}`,
    )
    this.name = "PoolOverflowError"
    this.limit = limit
    this.statement = statement
  }
}

let suspended = 0
let enabled = true

/** Run `fn` with every pool guard off. For a test that deliberately issues
 *  several requests at once against one shared harness handle. */
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
 *  OWN pool in production (a background driver that calls makePostgres), or a
 *  route with a filed ticket for its width. Say which, in a comment, at the
 *  call site. A suite that exercises one request wants the guard on. */
export function setPoolGuardEnabled(next: boolean): void {
  enabled = next
}

function describeStatement(target: unknown, method: string): string {
  const sql = (target as { _sql?: () => string })._sql?.()
  if (typeof sql === "string" && sql.trim() !== "") {
    const flat = sql.replace(/\s+/g, " ").trim()
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
  }
  return `${method}() (no SQL text)`
}

/**
 * Wrap a harness database handle so it throws PoolOverflowError instead of
 * taking on a unit of work past `limit` (default DEFAULT_POOL_MAX) at once.
 *
 * Every object the handle hands back — `prepare()`, `bind()`, `withUser()`,
 * `asAdmin()` — comes back wrapped too, so the whole handle shares one count.
 */
export function guardPoolOverflow<T extends object>(db: T, limit = DEFAULT_POOL_MAX): T {
  let active = 0
  const wrap = <O extends object>(target: O): O =>
    new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj) as unknown
        if (typeof value !== "function") return value
        const name = String(prop)
        return (...args: unknown[]) => {
          if (!UNIT_METHODS.has(name)) {
            const out = Reflect.apply(value, obj, args) as unknown
            if (UNCOUNTED_FROM.has(name)) return out
            // prepare() / bind() / withUser() hand back more of the surface.
            return out && typeof out === "object" && !(out instanceof Promise) ? wrap(out) : out
          }
          if (enabled && suspended === 0 && active >= limit) {
            // Rejected, not thrown: a route that fires a statement in the
            // background with its own .catch() should see this the way it
            // would see any other failed statement, not as a synchronous
            // throw out of the call site.
            return Promise.reject(new PoolOverflowError(limit, describeStatement(obj, name)))
          }
          active += 1
          let settled: Promise<unknown>
          try {
            settled = Reflect.apply(value, obj, args) as Promise<unknown>
          } catch (e) {
            active -= 1
            throw e
          }
          return settled.finally(() => { active -= 1 })
        }
      },
    })
  return wrap(db)
}
