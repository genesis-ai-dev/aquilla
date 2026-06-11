// Real-Postgres test DB (PGlite, in-process WASM) behind the Postgres shim.
//
// Replaces the hand-rolled SQL-pattern in-memory-db: tests now run the exact prod
// code path (the Postgres shim) against a real Postgres engine, so dialect +
// FTS (tsvector) are validated for real. Schema is the canonical db/postgres/
// schema.sql. Use makeTestDb() per suite; call reset() between tests.
import { PGlite } from "@electric-sql/pglite"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { PostgresDb, type PgExecutor } from "../../../../db/shim/postgres"

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

/** Seed data: { tableName: rowObjects[] } — column names must match the schema.
 *  Rows are `object` (not `Record<string, unknown>`) so typed interface rows
 *  like CellRow/EventRow, which lack index signatures, are accepted as-is.
 *  `cells_fts` is ignored (Postgres maintains FTS via the generated column). */
export type Seed = Partial<Record<string, ReadonlyArray<object>>>

export interface TestDb {
  /** Cast to AquillaDb — the shim is structurally compatible for the methods used. */
  db: AquillaDb
  /** Raw PGlite handle for assertions / seeding outside the SQL surface. */
  pg: PGlite
  /** Read every row of a table (async replacement for the old fake's _tables()). */
  rows<T = Record<string, unknown>>(table: string): Promise<T[]>
  /** All public tables as { tableName: rows[] } — async drop-in for db._tables(). */
  snapshot(): Promise<Record<string, Array<Record<string, unknown>>>>
  /** Truncate every app table (RESTART IDENTITY) — call between tests. */
  reset(): Promise<void>
  close(): Promise<void>
}

interface ColMeta {
  name: string
  type: string
  notNull: boolean
  hasDefault: boolean
  generated: boolean
}

async function tableMeta(pg: PGlite, table: string): Promise<ColMeta[]> {
  const r = await pg.query<{
    column_name: string
    data_type: string
    is_nullable: string
    column_default: string | null
    is_identity: string
    is_generated: string
  }>(
    `SELECT column_name, data_type, is_nullable, column_default, is_identity, is_generated
     FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  )
  return r.rows.map((x) => ({
    name: x.column_name,
    type: x.data_type,
    notNull: x.is_nullable === "NO",
    hasDefault: x.column_default != null || x.is_identity === "YES",
    generated: x.is_generated === "ALWAYS",
  }))
}

function typeDefault(type: string): unknown {
  if (/int|numeric|double|real|decimal/.test(type)) return 0
  if (type.includes("timestamp") || type.includes("date")) return new Date(0).toISOString()
  if (type === "boolean") return false
  return "" // text / varchar / etc.
}

// Seed rows tolerantly (the legacy fake had no constraints): drop unknown +
// generated columns, and auto-fill required (NOT NULL, no default) columns the
// seed omits with a type-appropriate placeholder so real-PG constraints pass.
async function seedRows(pg: PGlite, table: string, rows: ReadonlyArray<object>) {
  if (rows.length === 0) return
  const meta = await tableMeta(pg, table)
  for (const row of rows as ReadonlyArray<Record<string, unknown>>) {
    const cols: string[] = []
    const vals: unknown[] = []
    for (const m of meta) {
      if (m.generated) continue
      const has = m.name in row
      let v = has ? row[m.name] : undefined
      if (v === undefined || v === null) {
        if (m.hasDefault) continue // let PG fill (identity / DEFAULT)
        if (m.notNull) v = typeDefault(m.type) // required but omitted → placeholder
        else if (!has) continue // nullable + not provided → omit
        else v = null // explicit null on a nullable column
      }
      cols.push(m.name)
      vals.push(v)
    }
    if (cols.length === 0) continue
    const ph = cols.map((_, i) => `$${i + 1}`).join(",")
    await pg.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${ph})`, vals)
  }
}

export async function makeTestDb(seed: Seed = {}): Promise<TestDb> {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  for (const [table, rows] of Object.entries(seed)) {
    if (!rows || table === "cells_fts") continue // FTS is a generated column in PG
    await seedRows(pg, table, rows)
  }
  const db = new PostgresDb(pgliteExecutor(pg)) as unknown as AquillaDb
  return {
    db,
    pg,
    rows: async <T = Record<string, unknown>>(table: string) =>
      (await pg.query<T>(`SELECT * FROM ${table}`)).rows,
    snapshot: async () => {
      const tbls = await pg.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )
      const out: Record<string, Array<Record<string, unknown>>> = {}
      for (const { tablename } of tbls.rows) {
        out[tablename] = (await pg.query<Record<string, unknown>>(`SELECT * FROM ${tablename}`)).rows
      }
      return out
    },
    reset: async () => {
      await pg.exec(`DO $$ DECLARE r RECORD; BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
          EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
        END LOOP; END $$;`)
    },
    close: () => pg.close(),
  }
}
