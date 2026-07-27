#!/usr/bin/env tsx
// Migration guard for the live Neon Postgres DB.
//
// Closes the recurring prod-500 class (AQU-135, AQU-150, AQU-158, 2026-06-10
// projects.is_active): a migration file lands in db/postgres/migrations/ but
// is never applied to live Neon, and a worker deploy that references the new
// column silently outruns the schema. Mirrors what scripts/dev-stack.ts
// already does for local dev (dev_pg_migrations), using a `schema_migrations`
// ledger table on the live DB.
//
//   npx tsx scripts/neon-migrate.ts status     read-only check (default).
//       Fails (exit 1) if any migration file is not recorded in the ledger,
//       if the ledger table doesn't exist yet, or if any table/column in
//       db/postgres/schema.sql is missing from the live information_schema.
//   npx tsx scripts/neon-migrate.ts apply      apply pending migrations in
//       filename order and record them. Refuses to run until the DB has been
//       baselined — re-running ALL historical files on a live DB is unsafe
//       (0031 drops + recreates `snapshots`).
//   npx tsx scripts/neon-migrate.ts baseline   one-time bootstrap: create the
//       ledger and mark every existing migration file as applied WITHOUT
//       running it. Refuses if the schema diff shows drift — fix the drift by
//       hand first (npx tsx scripts/pg.ts db/postgres/migrations/00XX.sql),
//       then baseline.
//
// Connects via NEON_PG_* (loaded from .env automatically if not already in
// the environment — CI passes them as secrets). Targets whatever branch
// NEON_PG_HOST points at; override it to check the staging Neon branch.
//
// Convention (unchanged): every migration file must be idempotent
// (IF NOT EXISTS guards) and schema.sql must be kept up to date as the
// rollup, since the schema diff here treats it as the source of truth.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Client } from "pg"
import { neonClient } from "./pg"
import {
  diffSchemaContract,
  expectedSchemaContract,
  readLiveSchemaContract,
} from "./neon-schema-contract"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SCHEMA_FILE = path.join(REPO_ROOT, "db", "postgres", "schema.sql")
const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "postgres", "migrations")
const LEDGER = "schema_migrations"

/** Fill missing NEON_PG_* from .env so npm scripts work without `set -a`. */
function loadDotEnv(): void {
  if (process.env.NEON_PG_HOST && process.env.NEON_PG_PASSWORD) return
  const envFile = path.join(REPO_ROOT, ".env")
  if (!fs.existsSync(envFile)) return
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(NEON_PG_[A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
}

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
}

/** Diff the declarative schema plus security invariants from migrations. */
async function schemaDrift(client: Client): Promise<{
  problems: string[]
  tables: number
  columns: number
  constraints: number
  indexes: number
  policies: number
}> {
  const expected = expectedSchemaContract(
    fs.readFileSync(SCHEMA_FILE, "utf8"),
    migrationFiles().map((file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")),
  )
  const live = await readLiveSchemaContract(client)
  return {
    problems: diffSchemaContract(expected, live),
    tables: expected.tables.size,
    columns: [...expected.tables.values()].reduce((sum, table) => sum + table.size, 0),
    constraints: expected.constraints.size,
    indexes: expected.indexes.size,
    policies: [...expected.policies.values()].reduce((sum, policies) => sum + policies.size, 0),
  }
}

async function ledgerExists(client: Client): Promise<boolean> {
  const { rows } = await client.query(`SELECT to_regclass('public.${LEDGER}') AS t`)
  return rows[0]?.t != null
}

async function appliedNames(client: Client): Promise<Set<string>> {
  const { rows } = await client.query(`SELECT name FROM ${LEDGER}`)
  return new Set((rows as { name: string }[]).map((r) => r.name))
}

async function status(client: Client): Promise<number> {
  let failures = 0

  if (!(await ledgerExists(client))) {
    console.log(`✗ ledger table ${LEDGER} does not exist — run: npx tsx scripts/neon-migrate.ts baseline`)
    failures++
  } else {
    const applied = await appliedNames(client)
    const files = migrationFiles()
    const pending = files.filter((f) => !applied.has(f))
    const orphans = [...applied].filter((n) => !files.includes(n)).sort()
    if (pending.length) {
      for (const f of pending) console.log(`✗ pending migration: ${f}`)
      console.log(`  apply with: npx tsx scripts/neon-migrate.ts apply`)
      failures += pending.length
    } else {
      console.log(`✓ ledger: all ${files.length} migration files recorded as applied`)
    }
    // Recorded-but-deleted files are informational — they don't block deploys.
    for (const n of orphans) console.log(`⚠ ledger row has no matching file: ${n}`)
  }

  const drift = await schemaDrift(client)
  if (drift.problems.length) {
    for (const p of drift.problems) console.log(`✗ schema drift: ${p}`)
    failures += drift.problems.length
  } else {
    console.log(
      `✓ schema: ${drift.tables} tables / ${drift.columns} columns / ` +
      `${drift.constraints} named constraints / ${drift.indexes} indexes / ${drift.policies} RLS policies match live`,
    )
  }

  console.log(failures ? `\nFAIL — ${failures} problem(s); do not deploy workers against this DB` : "\nOK — schema is current")
  return failures ? 1 : 0
}

async function apply(client: Client): Promise<number> {
  if (!(await ledgerExists(client))) {
    console.error(
      `✗ ${LEDGER} does not exist. Refusing to apply: a first run would re-execute ALL ` +
        `historical migrations (0031 drops + recreates snapshots). Run baseline first.`,
    )
    return 1
  }
  const applied = await appliedNames(client)
  const pending = migrationFiles().filter((f) => !applied.has(f))
  if (!pending.length) {
    console.log("✓ nothing to apply")
  }
  for (const f of pending) {
    console.log(`applying ${f}…`)
    // One multi-statement query = one implicit transaction: a failing
    // statement rolls the whole file back and we abort loudly rather than
    // recording a half-applied migration (same approach as dev-stack.ts).
    await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))
    await client.query(`INSERT INTO ${LEDGER} (name) VALUES ($1)`, [f])
    console.log(`✓ applied ${f}`)
  }
  return status(client)
}

async function baseline(client: Client): Promise<number> {
  const drift = await schemaDrift(client)
  if (drift.problems.length) {
    for (const p of drift.problems) console.error(`✗ schema drift: ${p}`)
    console.error(
      `\nRefusing to baseline: marking migrations as applied would hide the drift above. ` +
        `Apply the missing pieces by hand (npx tsx scripts/pg.ts db/postgres/migrations/00XX.sql), then re-run baseline.`,
    )
    return 1
  }
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )
  for (const f of migrationFiles()) {
    await client.query(`INSERT INTO ${LEDGER} (name) VALUES ($1) ON CONFLICT DO NOTHING`, [f])
  }
  console.log(`✓ baselined: ${migrationFiles().length} migration files recorded in ${LEDGER} (none executed)`)
  return status(client)
}

async function main() {
  const cmd = process.argv[2] ?? "status"
  if (!["status", "apply", "baseline"].includes(cmd)) {
    console.error("usage: neon-migrate.ts [status|apply|baseline]")
    process.exit(1)
  }
  // pg.ts reads NEON_PG_* at neonClient() call time, so loading .env here
  // (after import) is safe.
  loadDotEnv()
  const client = neonClient()
  await client.connect()
  try {
    const host = process.env.NEON_PG_HOST
    console.log(`neon-migrate ${cmd} → ${host}\n`)
    const fns = { status, apply, baseline } as const
    process.exit(await fns[cmd as keyof typeof fns](client))
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  // Fail closed: an unreachable DB blocks the deploy too.
  console.error(String(e))
  process.exit(1)
})
