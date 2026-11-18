#!/usr/bin/env tsx
// Tiny Neon Postgres runner for the D1→Postgres migration tooling.
//   npx tsx scripts/pg.ts <file.sql>     — execute a .sql file (multi-statement)
//   npx tsx scripts/pg.ts "SELECT 1"     — execute one inline statement, print rows
// Connects to the DIRECT host (NEON_PG_HOST) for DDL/bulk work, not the pooler.
// Load creds first: set -a; . ./.env; set +a
import fs from "node:fs"
import { neonClient } from "./neon-connection"

// The connection helpers live in neon-connection.ts (no shebang, so a test can
// import them); every script that imported them from here still can.
export { neonClient, neonConfig } from "./neon-connection"


async function main() {
  const arg = process.argv[2]
  if (!arg) throw new Error("usage: pg.ts <file.sql | SQL>")
  const sql = arg.endsWith(".sql") ? fs.readFileSync(arg, "utf8") : arg
  const c = neonClient()
  await c.connect()
  try {
    const res = await c.query(sql)
    const results = Array.isArray(res) ? res : [res]
    for (const r of results) {
      if (r.rows?.length) console.table(r.rows.slice(0, 50))
      else console.log(`${r.command ?? "ok"}${r.rowCount != null ? ` rows=${r.rowCount}` : ""}`)
    }
  } finally {
    await c.end()
  }
}

if (process.argv[1]?.endsWith("pg.ts")) main().catch((e) => { console.error(String(e)); process.exit(1) })
