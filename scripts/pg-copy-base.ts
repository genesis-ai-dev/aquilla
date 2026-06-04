#!/usr/bin/env tsx
// Stage C, step 1: copy the identity/org layer D1 → Neon as-is.
//
// These tables are small and already correct in D1 (result of the frontier-db-v2
// user import + GitLab groups import). Copying is faster + safer than re-deriving.
// Content (projects/files/events) is re-imported fresh from GitLab separately.
//
// Idempotent: ON CONFLICT (pk) DO NOTHING. Identity sequences reset afterward so
// new PG inserts don't collide with copied ids. Run: set -a; . ./.env; set +a
import { execFileSync } from "node:child_process"
import { neonClient } from "./pg"

const TABLES = ["users", "organizations", "groups", "org_members", "group_members"] as const
const PK: Record<string, string> = {
  users: "id",
  organizations: "id",
  groups: "id",
  org_members: "org_id, user_id",
  group_members: "group_id, user_id",
}
const IDENTITY = ["users", "organizations", "groups"]

function d1All(table: string): Record<string, unknown>[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "aquilla-db", "--remote", "--json", "--command", `SELECT * FROM ${table}`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  )
  return JSON.parse(out.slice(out.indexOf("[")))[0].results
}

async function main() {
  const c = neonClient()
  await c.connect()
  try {
    for (const t of TABLES) {
      const rows = d1All(t)
      if (!rows.length) {
        console.log(`${t}: 0 rows`)
        continue
      }
      const cols = Object.keys(rows[0])
      let inserted = 0
      const BATCH = 500
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH)
        const params: unknown[] = []
        const tuples = chunk.map((r) => {
          const ph = cols.map((col) => {
            params.push(r[col] ?? null)
            return `$${params.length}`
          })
          return `(${ph.join(",")})`
        })
        const sql = `INSERT INTO ${t} (${cols.join(",")}) VALUES ${tuples.join(",")} ON CONFLICT (${PK[t]}) DO NOTHING`
        const res = await c.query(sql, params)
        inserted += res.rowCount ?? 0
      }
      console.log(`${t}: read ${rows.length}, inserted ${inserted}`)
    }
    for (const t of IDENTITY) {
      await c.query(
        `SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM ${t}),1))`,
      )
    }
    console.log("identity sequences reset")
  } finally {
    await c.end()
  }
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
