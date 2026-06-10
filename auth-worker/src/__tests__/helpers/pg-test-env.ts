// PGlite-backed replacement for the `cloudflare:test` module.
//
// auth-worker tests used to run on miniflare's D1 (real SQLite), which validated
// SQLite dialect — not Postgres, the production engine after the Neon cutover.
// vitest.config.ts aliases "cloudflare:test" to this module so every test now
// runs the worker's SQL against real Postgres (PGlite, in-process WASM) through
// the exact production Postgres shim (db/shim/postgres.ts). Same engine
// family as Neon, so dialect + FTS (generated tsvector) are validated for real.
//
// `env` is a module singleton; vitest isolates test files into separate workers,
// so each file gets its own PGlite. setup-migrations.ts loads the schema before
// the suite and truncates between tests.
import { PGlite } from "@electric-sql/pglite"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { PostgresDb, type PgExecutor } from "../../../../db/shim/postgres"

const SCHEMA = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../db/postgres/schema.sql"),
  "utf8",
)

// Mirror the production shim's type coercion (makePostgres): int8 (COUNT/SUM,
// server_seq, *_ms) → JS number, so test assertions see the same types prod does
// instead of PGlite's default bigint-as-string.
export const pg = new PGlite({ parsers: { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) } })

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

// The worker reads these off c.env. Mirrors auth-worker/wrangler.toml [vars] +
// the test overrides from the old vitest.config (PLATFORM_ADMINS pinned to root).
export const env = {
  AQUILLA_PG: new PostgresDb(pgliteExecutor(pg)) as unknown as AquillaDb,
  SECRET_KEY: "frontier-test-secret",
  SYNC_SECRET_KEY: "sync-secret",
  ALGORITHM: "HS256",
  ACCESS_TOKEN_EXPIRE_MINUTES: "43200",
  PLATFORM_ADMINS: "root",
  EMAIL_FROM: "noreply@aquilla.app",
  BASE_URL: "https://aquilla.app",
  SYNC_WORKER_URL: "https://api.aquilla.app/sync",
  DEFAULT_LLM_MODEL: "anthropic/claude-sonnet-4.5",
  OPENROUTER_API_KEY: undefined as string | undefined,
  ENVIRONMENT: "test",
  // AI budget controls (FRO-265). Tests override these per-suite as needed.
  AI_BUDGET_ENFORCE: undefined as string | undefined,
  AI_ALLOWED_MODELS: undefined as string | undefined,
  AI_USER_DAILY_REQUEST_LIMIT: undefined as string | undefined,
  AI_GLOBAL_DAILY_REQUEST_LIMIT: undefined as string | undefined,
}

/** Load the canonical Postgres schema into the test PGlite (call once, beforeAll). */
export async function initTestSchema(): Promise<void> {
  await pg.exec(SCHEMA)
}

/** Truncate every app table + reset identities between tests. */
export async function resetTestDb(): Promise<void> {
  await pg.exec(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
      EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
    END LOOP; END $$;`)
}

/** No-op: D1 migrations are replaced by the Postgres schema load (initTestSchema). */
export async function applyD1Migrations(): Promise<void> {}
