#!/usr/bin/env tsx
// Tiny Neon Postgres runner for the D1→Postgres migration tooling.
//   npx tsx scripts/pg.ts <file.sql>     — execute a .sql file (multi-statement)
//   npx tsx scripts/pg.ts "SELECT 1"     — execute one inline statement, print rows
// Connects to the DIRECT host (NEON_PG_HOST) for DDL/bulk work, not the pooler.
// Load creds first: set -a; . ./.env; set +a
import fs from "node:fs"
import { Client } from "pg"

export function neonClient(pooled = false): Client {
  const host = pooled ? process.env.NEON_PG_POOLER_HOST : process.env.NEON_PG_HOST
  if (!host || !process.env.NEON_PG_PASSWORD) {
    throw new Error("Neon creds missing — run: set -a; . ./.env; set +a")
  }
  return new Client({
    host,
    database: process.env.NEON_PG_DB,
    user: process.env.NEON_PG_ROLE,
    password: process.env.NEON_PG_PASSWORD,
    port: 5432,
    ssl: { rejectUnauthorized: true }, // Neon uses publicly-trusted certs
  })
}

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
