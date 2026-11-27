// The test database harness itself (db/shared/test-pg-harness.ts): every
// makeTestDb() is a copy of one template, and reset() empties only what a
// test wrote. Both are shortcuts for something slower, so these pin that the
// shortcut leaves exactly what the slow way left.
import { existsSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { TEST_PG_TEMPLATE_ENV } from "../../../db/shared/test-pg-harness"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { USED_AFTER_CLOSE } from "./helpers/test-db-lifetime"

const USER = `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`

async function count(t: TestDb, sql: string): Promise<number> {
  return Number((await t.pg.query<{ n: number }>(sql)).rows[0].n)
}

/** Public tables that hold a row, counted the slow way: one COUNT per table. */
async function tablesWithRows(t: TestDb): Promise<string[]> {
  const tables = await t.pg.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
  const held: string[] = []
  for (const { tablename } of tables.rows) {
    if ((await count(t, `SELECT count(*) AS n FROM "${tablename}"`)) > 0) held.push(tablename)
  }
  return held.sort()
}

describe("test database template", () => {
  it("is built once for the run, not once per test file", () => {
    // vitest.config.ts globalSetup. Without it every file quietly builds its
    // own template and the suite is minutes slower with nothing red.
    const file = process.env[TEST_PG_TEMPLATE_ENV]
    expect(file, `${TEST_PG_TEMPLATE_ENV} is not set: the globalSetup did not run`).toBeTruthy()
    expect(existsSync(file!)).toBe(true)
  })

  it("gives each makeTestDb() the whole schema and a database of its own", async () => {
    const a = await makeTestDb()
    const b = await makeTestDb()
    try {
      expect(await count(a, `SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`)).toBeGreaterThan(100)
      await a.pg.query(USER, ["ada", "ada@example.com"])
      expect(await count(a, `SELECT count(*) AS n FROM users`)).toBe(1)
      expect(await count(b, `SELECT count(*) AS n FROM users`)).toBe(0)
      // Identities are per database too: b's first user is 1, not 2.
      expect((await b.pg.query<{ id: number }>(USER, ["bea", "bea@example.com"])).rows[0].id).toBe(1)
    } finally {
      await a.close()
      await b.close()
    }
  })

  it("mints lanes in a copied database: the fill is a session setting the copy has to switch on", async () => {
    const t = await makeTestDb({
      cells: [{ project_id: "p1", file_id: "f1", cell_id: "c1", side: "target", event_id: "e1" }],
    })
    try {
      const cells = await t.pg.query<{ lane_id: string | null }>(`SELECT lane_id FROM cells`)
      expect(cells.rows).toHaveLength(1)
      expect(cells.rows[0].lane_id).toBeTruthy()
      expect(await count(t, `SELECT count(*) AS n FROM lanes WHERE project_id = 'p1' AND role = 'target'`)).toBe(1)
    } finally {
      await t.close()
    }
  })
})

describe("reset()", () => {
  it("leaves no row in any table, including ones only a CASCADE reaches", async () => {
    const t = await makeTestDb({
      cells: [{ project_id: "p1", file_id: "f1", cell_id: "c1", side: "source", event_id: "e1" }],
    })
    try {
      await t.pg.query(USER, ["ada", "ada@example.com"])
      expect(await tablesWithRows(t)).toEqual(expect.arrayContaining(["cells", "lanes", "users"]))

      await t.reset()

      expect(await tablesWithRows(t)).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("restarts identities, including one that moved for a row that was never stored", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(USER, ["ada", "ada@example.com"])
      await t.reset()
      // The identity is taken before NOT NULL rejects the row, so the
      // sequence moves while the table still has no page to truncate.
      await expect(t.pg.query(`INSERT INTO users (username) VALUES ('no-email')`)).rejects.toThrow(/null value/)
      expect(await count(t, `SELECT count(*) AS n FROM pg_sequences WHERE last_value IS NOT NULL`)).toBe(1)

      await t.reset()

      expect(await count(t, `SELECT count(*) AS n FROM pg_sequences WHERE last_value IS NOT NULL`)).toBe(0)
      expect((await t.pg.query<{ id: number }>(USER, ["bea", "bea@example.com"])).rows[0].id).toBe(1)
    } finally {
      await t.close()
    }
  })

  it("switches the lane fill back on after a test turned it off", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.exec(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
      await t.reset()
      const setting = await t.pg.query<{ v: string }>(`SELECT current_setting('aquilla.test_lane_fill', true) AS v`)
      expect(setting.rows[0].v).toBe("on")
    } finally {
      await t.close()
    }
  })
})

// An open database is about 180 MB, and most tests never close theirs. These
// run in order: each `it` is one test going by.
describe("when the harness closes a database", () => {
  let suiteOwned: TestDb
  let lazy: TestDb | undefined
  let madeInFirstTest: TestDb
  const perTest: TestDb[] = []

  beforeAll(async () => {
    suiteOwned = await makeTestDb()
  })
  afterAll(async () => {
    await suiteOwned.close()
  })
  // The spelling a great many suites use to share one database.
  beforeEach(async () => {
    if (!lazy) lazy = await makeTestDb()
    else await lazy.reset()
  })

  it("test 1 makes a database and does not close it", async () => {
    madeInFirstTest = await makeTestDb()
    perTest.push(madeInFirstTest)
    await madeInFirstTest.pg.query(USER, ["ada", "ada@example.com"])
  })

  it("test 2 carries on with it", async () => {
    perTest.push(await makeTestDb())
    expect(await count(madeInFirstTest, `SELECT count(*) AS n FROM users`)).toBe(1)
  })

  it("test 3 still has it, because test 2 used it", async () => {
    perTest.push(await makeTestDb())
    expect(madeInFirstTest.pg.closed).toBe(false)
    expect(await count(madeInFirstTest, `SELECT count(*) AS n FROM users`)).toBe(1)
  })

  it("test 4 does not use it", async () => {
    perTest.push(await makeTestDb())
  })

  it("test 5 asks for a database, and one unused since test 3 is closed and says why", async () => {
    perTest.push(await makeTestDb())
    expect(madeInFirstTest.pg.closed).toBe(true)
    expect(() => madeInFirstTest.pg.query(`SELECT 1`)).toThrow(USED_AFTER_CLOSE)
    await expect(madeInFirstTest.reset()).rejects.toThrow(USED_AFTER_CLOSE)
    // Test 2's and test 3's were not used after their own tests either.
    expect(perTest.map((db) => db.pg.closed)).toEqual([true, true, true, false, false])
  })

  it("never closes a database made in beforeAll, nor one every test resets", async () => {
    expect(suiteOwned.pg.closed).toBe(false)
    expect(await count(suiteOwned, `SELECT count(*) AS n FROM users`)).toBe(0)
    expect(lazy!.pg.closed).toBe(false)
  })

  it("lets a test close its own database, twice, or after the harness has", async () => {
    const mine = await makeTestDb()
    await mine.close()
    await mine.close()
    await madeInFirstTest.close()
    await madeInFirstTest.pg.close()
  })
})
