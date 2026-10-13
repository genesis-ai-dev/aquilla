import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  applyMigrationFile,
  hasOwnTransactionControl,
  planMigration,
  scanSql,
  transactionalSql,
} from "./neon-migration-file"

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "postgres",
  "migrations",
)

/** A client that records what the runner sent, and can fail on cue. */
function fakeClient(fail?: { on: RegExp; error: Error & { code?: string } }) {
  const queries: string[] = []
  return {
    queries,
    query: async (text: string) => {
      queries.push(text)
      if (fail && fail.on.test(text)) throw fail.error
      return { rows: [] } as never
    },
  }
}

function lockError(): Error & { code?: string } {
  const error = new Error("canceling statement due to lock timeout") as Error & { code?: string }
  error.code = "55P03"
  return error
}

describe("scanSql", () => {
  it("blanks comments and string literals but keeps executable SQL", () => {
    const { code } = scanSql(
      "-- CREATE INDEX CONCURRENTLY in a comment\n/* and CONCURRENTLY in a block */\nSELECT 'CONCURRENTLY';",
    )
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expect(code).toContain("SELECT")
  })

  it("does not split on semicolons inside dollar-quoted bodies", () => {
    const sql = "DO $$ BEGIN RAISE NOTICE 'a; b'; END $$;\nALTER TABLE cells ADD COLUMN x TEXT;"
    expect(scanSql(sql).statements).toHaveLength(2)
    expect(scanSql(sql).statements[1]).toBe("ALTER TABLE cells ADD COLUMN x TEXT;")
  })

  it("handles tagged dollar quotes and doubled quotes", () => {
    const sql = "DO $tag$ SELECT 1; $tag$;\nSELECT 'it''s; fine';"
    expect(scanSql(sql).statements).toHaveLength(2)
  })

  it("does not count a trailing comment as a statement", () => {
    expect(scanSql("SELECT 1;\n-- done\n").statements).toEqual(["SELECT 1;"])
  })
})

describe("planMigration", () => {
  it("takes the non-transactional path only for executable CONCURRENTLY", () => {
    expect(planMigration("CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON cells(x);")).toMatchObject({
      mode: "non-transactional",
      reason: "concurrently",
    })
    // A file that only talks about CONCURRENTLY in its header is transactional.
    expect(
      planMigration("-- build it CONCURRENTLY by hand first\nALTER TABLE cells ADD COLUMN x TEXT;"),
    ).toMatchObject({ mode: "transactional" })
  })

  it("honours an explicit -- aquilla:no-transaction marker", () => {
    expect(planMigration("-- aquilla:no-transaction\nVACUUM cells;")).toMatchObject({
      mode: "non-transactional",
      reason: "marker",
    })
  })

  it("sees a file's own transaction control, and not a PL/pgSQL BEGIN", () => {
    expect(hasOwnTransactionControl("BEGIN;\nALTER TABLE cells ADD COLUMN x TEXT;\nCOMMIT;")).toBe(true)
    expect(hasOwnTransactionControl("DO $$ BEGIN PERFORM 1; END $$;")).toBe(false)
  })
})

describe("applyMigrationFile — the file and its ledger row commit together", () => {
  it("sends one query: BEGIN, the ledger row, the file, COMMIT", async () => {
    const client = fakeClient()
    const plan = await applyMigrationFile(
      client, "0170_x.sql", "ALTER TABLE cells ADD COLUMN x TEXT;", { lockTimeout: "5s" },
    )
    expect(plan.mode).toBe("transactional")
    // One query is the whole point: the runner cannot die between the DDL and
    // the ledger row, because there is no gap to die in (AQU-1877).
    expect(client.queries).toHaveLength(1)
    const sent = client.queries[0]
    expect(sent.indexOf("INSERT INTO schema_migrations")).toBeLessThan(sent.indexOf("ALTER TABLE"))
    expect(sent).toMatch(/^BEGIN;/)
    expect(sent).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sent.trimEnd()).toMatch(/COMMIT;$/)
    expect(sent).toContain("INSERT INTO schema_migrations (name) VALUES ('0170_x.sql')")
  })

  it("wraps a file that opens its own transaction, ledger row inside it", () => {
    const sent = transactionalSql(
      "0150_x.sql", "BEGIN;\nUPDATE cells SET x = 1;\nCOMMIT;", "5s",
    )
    // The file's COMMIT commits our transaction, ledger row included, because
    // the row was inserted before the file ran.
    expect(sent.indexOf("INSERT INTO schema_migrations")).toBeLessThan(sent.indexOf("UPDATE cells"))
  })

  it("adds the missing terminator when a file does not end in a semicolon", () => {
    expect(transactionalSql("0170_x.sql", "ALTER TABLE cells ADD COLUMN x TEXT", "5s"))
      .toContain("ALTER TABLE cells ADD COLUMN x TEXT;\nCOMMIT;")
  })

  it("never writes the ledger row when the file fails", async () => {
    const client = fakeClient({ on: /CREATE INDEX CONCURRENTLY/, error: new Error("boom") })
    await expect(
      applyMigrationFile(client, "0171_x.sql", "CREATE INDEX CONCURRENTLY i ON cells(x);"),
    ).rejects.toThrow("boom")
    expect(client.queries.some((q) => q.includes("INSERT INTO schema_migrations"))).toBe(false)
  })

  it("rejects a migration name that is not a plain filename", async () => {
    await expect(applyMigrationFile(fakeClient(), "0170'; DROP TABLE cells; --", "SELECT 1;"))
      .rejects.toThrow(/not a plain filename/)
  })
})

describe("applyMigrationFile — the documented non-transactional path", () => {
  it("runs each statement on its own under lock_timeout, ledger row last", async () => {
    const client = fakeClient()
    const plan = await applyMigrationFile(
      client,
      "0083_cells_scan_index.sql",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON cells(x);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS b ON cells(y);",
      { lockTimeout: "7s" },
    )
    expect(plan).toMatchObject({ mode: "non-transactional", reason: "concurrently" })
    expect(client.queries[0]).toBe("SET lock_timeout = '7s'")
    // No BEGIN anywhere: CONCURRENTLY cannot run inside a transaction block.
    expect(client.queries.some((q) => /^BEGIN;/.test(q))).toBe(false)
    expect(client.queries[1]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS a")
    expect(client.queries[2]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS b")
    expect(client.queries[3]).toContain("INSERT INTO schema_migrations")
    expect(client.queries[4]).toBe("SET lock_timeout = DEFAULT")
  })

  it("refuses a concurrent file that also manages its own transaction", async () => {
    await expect(
      applyMigrationFile(
        fakeClient(), "0172_x.sql", "BEGIN;\nCREATE INDEX CONCURRENTLY i ON cells(x);\nCOMMIT;",
      ),
    ).rejects.toThrow(/BEGIN\/COMMIT/)
  })
})

describe("lock_timeout failures are explained, not swallowed", () => {
  it("names the timeout and says the migration was not recorded", async () => {
    const client = fakeClient({ on: /ALTER TABLE/, error: lockError() })
    await expect(
      applyMigrationFile(client, "0173_x.sql", "ALTER TABLE events ADD COLUMN x TEXT;", { lockTimeout: "5s" }),
    ).rejects.toThrow(/lock_timeout=5s[\s\S]*NOT recorded/)
  })
})

describe("every real migration file still applies", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it("classifies each file and leaves nothing empty", () => {
    for (const file of files) {
      const plan = planMigration(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))
      expect(plan.statements.length, file).toBeGreaterThan(0)
    }
  })

  it("never sends CONCURRENTLY inside a transaction block", () => {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
      const plan = planMigration(sql)
      if (plan.mode === "transactional") {
        expect(scanSql(sql).code, file).not.toMatch(/\bCONCURRENTLY\b/i)
      } else {
        // The non-transactional path cannot wrap the file, so the file must
        // not expect a transaction of its own.
        expect(hasOwnTransactionControl(sql), file).toBe(false)
      }
    }
  })

  it("keeps the files that manage their own transaction on the transactional path", () => {
    const selfManaged = files.filter((file) =>
      hasOwnTransactionControl(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")),
    )
    expect(selfManaged.length).toBeGreaterThan(0)
    for (const file of selfManaged) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
      expect(planMigration(sql).mode, file).toBe("transactional")
      // Their COMMIT is last, so it commits the ledger row this runner
      // inserted first. A file with statements after its COMMIT would leave
      // that tail outside the recorded transaction.
      expect(scanSql(sql).statements.at(-1)?.toUpperCase(), file).toMatch(/COMMIT\s*;$/)
    }
  })
})
