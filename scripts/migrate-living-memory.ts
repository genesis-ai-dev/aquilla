#!/usr/bin/env tsx
// Bulk-migrate project living-memory entries off the project_settings blob
// and onto `project_living_memory_entries`. (AQU-2719 step 1)
//
//   npx tsx scripts/migrate-living-memory.ts --list        show what would move
//   npx tsx scripts/migrate-living-memory.ts --apply       migrate every project
//   npx tsx scripts/migrate-living-memory.ts --apply <id>  migrate one project
//
// Load creds first: set -a; . ./.env; set +a  (and set NEON_PG_HOST for the
// branch you mean to touch — dev and production are DIFFERENT endpoints).
//
// WHY THIS EXISTS. A project moves on its next settings SAVE, which covers
// every project anyone is working in. This script is the backfill for the
// projects nobody saves, so the blob key does not sit there forever keeping
// every unrelated settings read paying to parse it.
//
// A READ DOES NOT MIGRATE, deliberately — the same call AQU-1006 made for
// terminology after a migrate-on-read of the largest dev termbase (961
// concepts) exceeded the Worker budget. A read that writes would also rewrite
// a multi-MB row underneath any racing human edit.
//
// Shares the EXACT code path with the worker
// (`migrateProjectLivingMemory` over the same Postgres shim), so there is no
// second implementation to drift.

import { makeMaintenancePostgres } from "../db/shim/postgres"
import {
  livingMemorySkipWarning,
  migrateProjectLivingMemory,
} from "../db/shared/living-memory-entries"
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

  const db = makeMaintenancePostgres(connectionString(), 4)
  try {
    // Only projects that still carry a non-empty array under the key. An
    // empty array is left where it is: there are no bytes to win, and
    // clearing it would turn a present-and-empty key into an absent one.
    const pending = await db
      .prepare(
        `SELECT project_id,
                jsonb_array_length((settings::jsonb)->'livingMemoryEntries') AS n,
                length(settings) AS blob_bytes
         FROM project_settings
         WHERE jsonb_typeof((settings::jsonb)->'livingMemoryEntries') = 'array'
           AND jsonb_array_length((settings::jsonb)->'livingMemoryEntries') > 0
         ORDER BY n DESC`,
      )
      .all<{ project_id: string; n: number; blob_bytes: number }>()

    const rows = only ? pending.results.filter((r) => r.project_id === only) : pending.results
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0)
    console.log(`${rows.length} project(s) with blob living-memory entries, ${total} entry(ies) total`)
    for (const r of rows) console.log(`  ${r.project_id}  ${r.n} entry(ies)  blob ${r.blob_bytes}B`)

    if (!apply) {
      console.log("\n(dry run — pass --apply to migrate)")
      return
    }

    let migrated = 0
    for (const r of rows) {
      const started = Date.now()
      const result = await migrateProjectLivingMemory(db, r.project_id)
      const ms = Date.now() - started
      migrated += result.count
      console.log(`  ✓ ${r.project_id}  ${result.count} entry(ies)  ${ms}ms`)
      if (result.skipped > 0) {
        console.warn(livingMemorySkipWarning(r.project_id, result.skipped))
      }
    }
    console.log(`\nmigrated ${migrated} entry(ies) across ${rows.length} project(s)`)
  } finally {
    await db.close?.()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
