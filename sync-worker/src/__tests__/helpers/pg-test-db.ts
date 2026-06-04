// Real-Postgres test DB (PGlite, in-process WASM) behind the D1 shim.
//
// Replaces the hand-rolled SQL-pattern d1-fake: tests now run the exact prod
// code path (the D1→Postgres shim) against a real Postgres engine, so dialect +
// FTS (tsvector) are validated for real. Schema is the canonical db/postgres/
// schema.sql. Use makeTestDb() per suite; call reset() between tests.
import { PGlite } from "@electric-sql/pglite"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { D1Postgres, type PgExecutor } from "../../../../db/shim/d1-postgres"

const SCHEMA = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../db/postgres/schema.sql"),
  "utf8",
)

function pgliteExecutor(db: PGlite): PgExecutor {
  const wrap = (q: { query: PGlite["query"]; transaction?: PGlite["transaction"] }): PgExecutor => ({
    async run(sql, params) {
      const r = await q.query<Record<string, unknown>>(sql, params as unknown[])
      return { rows: r.rows, rowCount: (r as { affectedRows?: number }).affectedRows ?? r.rows.length }
    },
    begin: (fn) => db.transaction((tx) => fn(wrap(tx as unknown as PGlite))) as Promise<never>,
  })
  return wrap(db)
}

export interface TestDb {
  /** Cast to D1Database — the shim is structurally compatible for the methods used. */
  db: D1Database
  /** Raw PGlite handle for assertions / seeding outside the D1 surface. */
  pg: PGlite
  /** Truncate every app table (RESTART IDENTITY) — call between tests. */
  reset(): Promise<void>
  close(): Promise<void>
}

export async function makeTestDb(): Promise<TestDb> {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  const db = new D1Postgres(pgliteExecutor(pg)) as unknown as D1Database
  const reset = async () => {
    await pg.exec(`DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP; END $$;`)
  }
  return { db, pg, reset, close: () => pg.close() }
}
