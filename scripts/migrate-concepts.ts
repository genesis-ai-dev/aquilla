#!/usr/bin/env tsx
// Bulk-migrate project termbases off the project_settings blob onto the
// concepts projection. (AQU-1006 follow-up)
//
//   npx tsx scripts/migrate-concepts.ts --list          show what would migrate
//   npx tsx scripts/migrate-concepts.ts --apply         migrate every project
//   npx tsx scripts/migrate-concepts.ts --apply <id>    migrate one project
//
// Load creds first: set -a; . ./.env; set +a  (and set NEON_PG_HOST for the
// branch you mean to touch — dev and production are DIFFERENT endpoints).
//
// WHY THIS EXISTS. The concepts read route does NOT migrate. A migrate-on-read
// of the largest dev termbase (961 concepts, 1922 statements) exceeded the
// Worker budget, so a read only decodes the blob while it is still there.
// This script is the cutover. It shares migrateProjectConcepts with no second
// parser: when that function reports skipped entries, the warning below is
// printed from the result.
//
// Shares the EXACT code path with the worker (`migrateProjectConcepts` over the
// same Postgres shim), so there is no second implementation to drift.

import { makePostgres } from "../db/shim/postgres"
import { migrateProjectConcepts, migrationSkipWarning } from "../sync-worker/src/events/migrate-concepts"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function loadDotEnv(): void {
  if (process.env.NEON_PG_HOST && process.env.NEON_PG_PASSWORD) return
  const envFile = path.join(REPO_ROOT, ".env")
  if (!fs.existsSync(envFile)) return
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(NEON_PG_[A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
}

function connectionString(): string {
  loadDotEnv()
  const host = process.env.NEON_PG_HOST
  const user = process.env.NEON_PG_USER ?? "neondb_owner"
  const password = process.env.NEON_PG_PASSWORD
  const database = process.env.NEON_PG_DATABASE ?? "neondb"
  if (!host || !password) {
    throw new Error("Neon creds missing — run: set -a; . ./.env; set +a")
  }
  return `postgres://${user}:${encodeURIComponent(password)}@${host}/${database}?sslmode=require` // secret-scan:allow — built from env vars, no literal credential
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const only = args.find((a) => !a.startsWith("--")) ?? null

  const db = makePostgres(connectionString(), 4)
  try {
    // Only projects that still carry a non-empty `terminology` array.
    const pending = await db
      .prepare(
        `SELECT project_id,
                jsonb_array_length((settings::jsonb)->'terminology') AS n
         FROM project_settings
         WHERE jsonb_typeof((settings::jsonb)->'terminology') = 'array'
           AND jsonb_array_length((settings::jsonb)->'terminology') > 0
         ORDER BY n DESC`,
      )
      .all<{ project_id: string; n: number }>()

    const rows = only ? pending.results.filter((r) => r.project_id === only) : pending.results
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0)
    console.log(`${rows.length} project(s) with a blob termbase, ${total} concept(s) total`)
    for (const r of rows) console.log(`  ${r.project_id}  ${r.n}`)

    if (!apply) {
      console.log("\n(dry run — pass --apply to migrate)")
      return
    }

    let migrated = 0
    for (const r of rows) {
      const started = Date.now()
      const result = await migrateProjectConcepts(db, r.project_id)
      const ms = Date.now() - started
      migrated += result.count
      console.log(`  ✓ ${r.project_id}  ${result.count} concept(s)  ${ms}ms`)
      if (result.skipped > 0) {
        console.warn(migrationSkipWarning(r.project_id, result.skipped))
      }
    }
    console.log(`\nmigrated ${migrated} concept(s) across ${rows.length} project(s)`)
  } finally {
    await db.close?.()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
