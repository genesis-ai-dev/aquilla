// When a test database is closed.
//
// An open PGlite holds its whole data directory and a WASM heap in memory:
// about 180 MB each. Most tests take one from makeTestDb() and never close it,
// and the garbage collector does not get to them until a test process holds
// 5–8 GB. While a database took ~2.4 s to build that was slow enough to
// survive on a 16 GB runner. Loaded from the template they are made five times
// as fast, and three test processes ran the runner out of memory within a
// minute (AQU-2788: both shards ended in "The runner has received a shutdown
// signal", with no failing test).
//
// So the harness closes what a test has finished with:
//
//   - A database made outside a test (`beforeAll`, module scope) belongs to
//     its suite. The harness never closes it.
//   - A database made during a test, `beforeEach` included, is kept through
//     the test after it and closed once a later test asks for a database,
//     unless that following test used it. Used counts: a reset, a query, a
//     route handed its `db`. A database every test carries on with is
//     therefore never closed, which is what the common
//     `if (!h) h = await makeTestDb(); else await h.reset()` in a
//     `beforeEach` needs.
//
// "Kept through the test after it" rather than "closed when its test ends" is
// also what lets work a test started and did not wait for finish against an
// open database.
//
// A database that sat out a whole test and is then used again has been closed,
// and says so (USED_AFTER_CLOSE). Make that one in `beforeAll`.
import type { PGlite } from "@electric-sql/pglite"
import { onTestFinished } from "vitest"

export const USED_AFTER_CLOSE =
  "This test database was closed by the test harness. A database made inside a test (or its " +
  "beforeEach) is kept through the following test, then closed if that test did not use it. " +
  "To share one across a suite, make it in beforeAll. See helpers/test-db-lifetime.ts."

interface Tracked {
  pg: PGlite
  /** Which test last used it, counted in tests that used the harness.
   *  Undefined for a database made outside a test: its suite owns it. */
  usedIn: number | undefined
  close: () => Promise<void>
}

const open = new Set<Tracked>()
let testNumber = 0
let testRunning = false

/** The running test's number, or undefined outside a test: `beforeAll`,
 *  module scope, or a run under another copy of vitest (the root suite's
 *  contract tests), where nothing is closed, as before. */
function currentTest(): number | undefined {
  if (testRunning) return testNumber
  try {
    onTestFinished(() => {
      testRunning = false
      testNumber++
    })
  } catch {
    return undefined
  }
  testRunning = true
  return testNumber
}

/** Close every database whose last use was before the previous test. Call
 *  before making a new one, which is the only point memory grows. */
export async function closeFinishedTestDbs(): Promise<void> {
  const now = currentTest()
  if (now === undefined) return
  const finished = [...open].filter((db) => db.usedIn !== undefined && db.usedIn < now - 1)
  await Promise.all(finished.map((db) => db.close()))
}

/** Track a new database, and make its handle record each use. */
export function trackTestDb(pg: PGlite): void {
  const closeNow = pg.close.bind(pg)
  let closedByHarness = false
  const tracked: Tracked = {
    pg,
    usedIn: currentTest(),
    close: async () => {
      closedByHarness = true
      await pg.close()
    },
  }
  open.add(tracked)

  const used = () => {
    if (closedByHarness) throw new Error(USED_AFTER_CLOSE)
    if (tracked.usedIn === undefined) return
    const now = currentTest()
    if (now !== undefined) tracked.usedIn = now
  }
  // Everything reaches the database through these four: the shim's executor,
  // the harness's own rows()/snapshot()/reset(), and a test's raw `pg`.
  const handle = pg as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const method of ["query", "exec", "sql", "transaction"]) {
    const call = handle[method].bind(pg)
    handle[method] = (...args: unknown[]) => {
      used()
      return call(...args)
    }
  }
  // A test's own close, after the harness's or a second time, is not an error.
  pg.close = async () => {
    open.delete(tracked)
    if (!pg.closed) await closeNow()
  }
}
