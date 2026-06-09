#!/usr/bin/env tsx
// Idempotent frontier-db-v2 → aquilla-db user import.
//
// Migrated events carry the original Frontier usernames as `author`; importing
// the legacy users makes that attribution resolve to real accounts. Dedup is by
// username + email (aquilla-db's two UNIQUE keys), so re-runs insert nothing.
//
// Reads frontier-db-v2 over the remote D1 API (read-only). Writes go to either
// the local dev aquilla-db or PROD — and only with --apply.
//
//   npx tsx scripts/migrate-users.ts                       # read source, report (safe)
//   npx tsx scripts/migrate-users.ts --target remote       # + read prod, show the plan
//   npx tsx scripts/migrate-users.ts --target remote --apply   # WRITE to prod aquilla-db
//   npx tsx scripts/migrate-users.ts --target local --apply    # WRITE to local dev D1
//
// Auth: uses your existing `wrangler login` session (same account that owns
// frontier-db-v2 + aquilla-db). NOTE: --target local runs `wrangler d1 execute
// --local` against .wrangler-dev-state, which contends with a running
// `pnpm dev`; stop the dev stack first if you target local.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { planUserImport, type SourceUser, type ExistingUser } from "../src/lib/migrate/users"

const FRONTIER_DB = "frontier-db-v2"
const AQUILLA_PG = "aquilla-db"
const PERSIST = ".wrangler-dev-state"
const INSERT_CHUNK = 100

function d1Query<T>(db: string, sql: string, remote: boolean): T[] {
  const args = ["d1", "execute", db, remote ? "--remote" : "--local", "--json"]
  if (!remote) args.push("--persist-to", PERSIST)
  args.push("--command", sql)
  const out = execFileSync("wrangler", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })
  const start = out.indexOf("[")
  if (start < 0) throw new Error(`unexpected wrangler output: ${out.slice(0, 200)}`)
  const parsed = JSON.parse(out.slice(start)) as Array<{ results: T[] }>
  return parsed[0]?.results ?? []
}

function sqlStr(s: string | null | undefined): string {
  return `'${(s ?? "").replace(/'/g, "''")}'`
}

function applyInserts(db: string, users: SourceUser[], remote: boolean): void {
  const now = new Date().toISOString().replace("T", " ").replace(/\..+/, "")
  const lines: string[] = []
  for (let i = 0; i < users.length; i += INSERT_CHUNK) {
    const values = users
      .slice(i, i + INSERT_CHUNK)
      .map(
        (u) =>
          `(${sqlStr(u.username)}, ${sqlStr(u.email)}, ${sqlStr(u.password_hash)}, ${sqlStr(u.created_at ?? now)}, ${sqlStr(u.updated_at ?? now)})`,
      )
      .join(",\n")
    lines.push(
      `INSERT INTO users (username, email, password_hash, created_at, updated_at) VALUES\n${values};`,
    )
  }
  const tmp = path.join(os.tmpdir(), `migrate-users-${users.length}.sql`)
  fs.writeFileSync(tmp, lines.join("\n"))
  const args = ["d1", "execute", db, remote ? "--remote" : "--local", "--file", tmp]
  if (!remote) args.push("--persist-to", PERSIST)
  execFileSync("wrangler", args, { stdio: "inherit" })
  fs.unlinkSync(tmp)
}

function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes("--apply")
  const ti = argv.indexOf("--target")
  const target = ti >= 0 ? argv[ti + 1] : undefined
  const remoteTarget = target === "remote"

  console.log(`Reading users from ${FRONTIER_DB} (remote, read-only)…`)
  const src = d1Query<SourceUser>(
    FRONTIER_DB,
    "SELECT username, email, password_hash, created_at, updated_at FROM users",
    true,
  )
  console.log(`  ${src.length} legacy users`)
  console.log("  sample:", src.slice(0, 5).map((u) => `${u.username} <${u.email}>`).join(", "))

  if (!target) {
    console.log(
      "\n[no --target] source read only. Re-run with --target local|remote to compute the dedup plan.",
    )
    return
  }

  console.log(`Reading existing users from ${AQUILLA_PG} (${remoteTarget ? "remote / PROD" : "local dev"})…`)
  const existing = d1Query<ExistingUser>(AQUILLA_PG, "SELECT username, email FROM users", remoteTarget)
  console.log(`  ${existing.length} existing`)

  const plan = planUserImport(src, existing)
  console.log(
    `\nPlan → insert ${plan.toInsert.length}, already present ${plan.alreadyPresent}, conflicts ${plan.conflicts.length}`,
  )
  if (plan.conflicts.length) {
    console.log("  first conflicts:")
    for (const c of plan.conflicts.slice(0, 5)) console.log(`    ${c.username} <${c.email}> — ${c.reason}`)
  }

  if (!apply) {
    console.log("\n[dry-run] no writes. Re-run with --apply to insert the new users.")
    return
  }
  if (plan.toInsert.length === 0) {
    console.log("\nNothing to insert — already idempotent.")
    return
  }
  console.log(
    `\n${remoteTarget ? "⚠️  WRITING TO PROD aquilla-db" : "Writing to local dev aquilla-db"} — ${plan.toInsert.length} users…`,
  )
  applyInserts(AQUILLA_PG, plan.toInsert, remoteTarget)
  console.log("✓ Done. Re-run without --apply to confirm 0 remain.")
}

main()
