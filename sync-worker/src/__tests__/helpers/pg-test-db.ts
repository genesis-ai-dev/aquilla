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
import { installTestLaneFill, rewriteTestLaneResolve } from "../../../../db/shared/test-lane-fill"
import { resetChainCacheForTests } from "../../events/cells-read-route"

const SCHEMA = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../db/postgres/schema.sql"),
  "utf8",
)

/**
 * AQU-1543: the most bound values postgres.js — the driver every worker reaches
 * Postgres through — will put in one statement. At 65,534 it throws
 * `MAX_PARAMETERS_EXCEEDED` before anything is sent.
 *
 * PGlite has no such client-side check, so without mirroring it here a test can
 * pass on a statement production cannot even send. That is how a mirror sync
 * whose single events INSERT bound 12 values × 5,546 rows stayed green in this
 * suite while failing on every attempt against a real database.
 */
export const DRIVER_MAX_BIND_PARAMS = 65_533

/** Projection tables whose target_lang column is no longer the lane tag. */
const WIRE_TAG_TABLES = new Set([
  "cells",
  "cell_validators",
  "file_section_progress",
  "assignments",
  "artifact_bindings",
  "scene_briefs",
  "contextual_runs",
  "contextual_drafts",
])

export interface TestDbOptions {
  /** Called with every statement the shim sends, inside and outside
   *  transactions, before it runs. For tests that pin how a code path SHAPES
   *  its statements (how many values one of them binds) rather than what the
   *  statements do. */
  onStatement?: (sql: string, params: readonly unknown[]) => void
}

function pgliteExecutor(db: PGlite, opts: TestDbOptions): PgExecutor {
  const wrap = (q: { query: PGlite["query"]; exec: PGlite["exec"]; transaction?: PGlite["transaction"] }): PgExecutor => ({
    async run(sql, params) {
      opts.onStatement?.(sql, params)
      // Shape tests see the production subquery. Execution mints the lane
      // from the tag that subquery binds, because writers no longer store it.
      sql = rewriteTestLaneResolve(sql)
      if (params.length > DRIVER_MAX_BIND_PARAMS) {
        // Same code and message as postgres.js, so a failure here reads exactly
        // like the production one it stands in for.
        throw Object.assign(
          new Error("MAX_PARAMETERS_EXCEEDED: Max number of parameters (65534) exceeded"),
          { code: "MAX_PARAMETERS_EXCEEDED" },
        )
      }
      // postgres.js sends a parameterless unsafe() over the simple protocol,
      // which accepts several statements (migration replays rely on it).
      if (params.length === 0) {
        const last = (await q.exec(sql)).at(-1)
        return { rows: (last?.rows ?? []) as Record<string, unknown>[], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 }
      }
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

export async function makeTestDb(seed: Seed = {}, opts: TestDbOptions = {}): Promise<TestDb> {
  // A fresh test database is a fresh "isolate": the cells chain cache is
  // module-level and keyed on projectId + ETag, and every spec reuses the
  // same ids/seqs across independent databases, so clear it here or a
  // previous test's ordering leaks into this one.
  resetChainCacheForTests()
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  // lane_id is NOT NULL. Tests that omit it get a lane minted by this trigger.
  await installTestLaneFill((sql) => pg.exec(sql))
  // Lanes before content rows, so an explicit seed lane wins over a minted one.
  const seeded = Object.entries(seed).filter(([table, rows]) => rows && table !== "cells_fts")
  seeded.sort((a, b) => Number(b[0] === "lanes") - Number(a[0] === "lanes"))
  for (const [table, rows] of seeded) {
    await seedRows(pg, table, rows!)
  }
  const db = new PostgresDb(pgliteExecutor(pg, opts)) as unknown as AquillaDb
  return {
    db,
    pg,
    rows: async <T = Record<string, unknown>>(table: string) => {
      // Writers leave target_lang at its default. Tests that ask rows()
      // "which lane?" get the wire tag, lanes.legacy_tag. The stored column
      // is what snapshot() and a direct query return.
      const result = await pg.query<T & { lane_id?: string | null; project_id?: string; target_lang?: string }>(
        `SELECT * FROM ${table}`,
      )
      if (!WIRE_TAG_TABLES.has(table) || result.rows.length === 0) return result.rows
      const lanes = await pg.query<{ project_id: string; id: string; legacy_tag: string | null }>(
        `SELECT project_id, id, legacy_tag FROM lanes`,
      )
      const tag = new Map(lanes.rows.map((l) => [`${l.project_id}\0${l.id}`, l.legacy_tag ?? ""]))
      return result.rows.map((row) => {
        const wire = tag.get(`${row.project_id}\0${row.lane_id}`)
        return wire === undefined ? row : { ...row, target_lang: wire }
      }) as T[]
    },
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
      resetChainCacheForTests() // same reason as in makeTestDb above
      await pg.exec(`DO $$ DECLARE r RECORD; BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
          EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
        END LOOP; END $$;`)
      await pg.exec(`SELECT set_config('aquilla.test_lane_fill', 'on', false)`)
    },
    close: () => pg.close(),
  }
}
