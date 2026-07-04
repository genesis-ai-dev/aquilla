#!/usr/bin/env tsx
// Load the seed bundle into a target Postgres (local dev PG or a Neon branch).
// Idempotent: deletes the seeded ids first, then bulk-inserts verbatim.
//
//   npx tsx scripts/seed-load.ts --local                 # default local dev PG
//   npx tsx scripts/seed-load.ts --target "postgresql://…"
//   LOCAL_PG_URL=… npx tsx scripts/seed-load.ts --local
//   flags: --ignore-schema-hash  (load despite schema drift — use with care)
//
// NEVER point --target at prod. The loader refuses hosts matching the prod host.
import { Client } from "pg"
import { createHash } from "node:crypto"
import { zstdDecompressSync } from "node:zlib"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SEED_TABLES, TABLE_HEADER_KEY, type IdSet } from "./lib/seed-tables"
import { ensureBundle, readMeta } from "./seed-fetch"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_LOCAL_PG_URL = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const GENERATED_COLS = new Set(["value_tsv"]) // never inserted (GENERATED ALWAYS)
const INSERT_CHUNK = 800
const IDENTITY_SEQ_TABLES = ["users", "organizations", "groups"] // loaded identity tables with IDENTITY ids
const OWNER_ROLE = 700 // ROLE.OWNER — see auth-worker/src/types.ts

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function targetUrl(): string {
  const i = process.argv.indexOf("--target")
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (process.argv.includes("--local")) return process.env.LOCAL_PG_URL || DEFAULT_LOCAL_PG_URL
  throw new Error("specify --local or --target <conn string>")
}

function parseBundle(raw: Buffer): Map<string, Record<string, unknown>[]> {
  const sections = new Map<string, Record<string, unknown>[]>()
  let current: Record<string, unknown>[] | null = null
  let lineStart = 0
  const parseLine = (lineEnd: number) => {
    const line = raw.toString("utf8", lineStart, lineEnd)
    lineStart = lineEnd + 1
    if (!line) return
    const obj = JSON.parse(line)
    if (TABLE_HEADER_KEY in obj) { current = []; sections.set(obj[TABLE_HEADER_KEY], current) }
    else current!.push(obj)
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0a) parseLine(i)
  }
  if (lineStart < raw.length) parseLine(raw.length)
  return sections
}

/** Fail loud (before any write) if the target is missing columns the bundle carries. */
async function assertTargetSchema(c: Client, sections: Map<string, Record<string, unknown>[]>) {
  const drift: string[] = []
  for (const t of SEED_TABLES) {
    const rows = sections.get(t.name) ?? []
    if (!rows.length) continue
    const want = Object.keys(rows[0]).filter((k) => !GENERATED_COLS.has(k))
    const have = new Set((await c.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t.name],
    )).rows.map((r) => r.column_name))
    for (const col of want) if (!have.has(col)) drift.push(`${t.name}.${col}`)
  }
  if (drift.length) {
    throw new Error(
      `target schema is stale — missing column(s): ${drift.join(", ")}\n` +
      `  apply the current db/postgres/schema.sql to the target before seeding ` +
      `(local: recreate the dev Postgres; Neon: run the outstanding migration).`,
    )
  }
}

async function insertRows(c: Client, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const cols = Object.keys(rows[0]).filter((k) => !GENERATED_COLS.has(k))
  const colList = cols.map((x) => `"${x}"`).join(", ")
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const ph = cols.map((col) => { params.push(row[col] ?? null); return `$${params.length}` })
      return `(${ph.join(", ")})`
    })
    await c.query(`INSERT INTO ${table} (${colList}) VALUES ${tuples.join(", ")}`, params)
  }
}

async function main() {
  const url = targetUrl()
  const host = new URL(url).hostname
  if (process.env.NEON_PG_HOST && host === process.env.NEON_PG_HOST) {
    throw new Error(`refusing to load into prod host ${host}`)
  }
  const meta = readMeta()

  // schema guard — the repo schema.sql must match what the bundle was built against.
  const schemaHash = createHash("sha256").update(fs.readFileSync(path.join(ROOT, "db", "postgres", "schema.sql"))).digest("hex")
  if (schemaHash !== meta.schemaHash) {
    const msg = `schema.sql hash ${schemaHash.slice(0, 12)}… != bundle ${meta.schemaHash.slice(0, 12)}… (schema drift)`
    if (!process.argv.includes("--ignore-schema-hash")) throw new Error(msg + " — re-run seed:extract or pass --ignore-schema-hash")
    console.warn("⚠ " + msg + " (ignored)")
  }

  const bundlePath = ensureBundle(meta)
  const sections = parseBundle(zstdDecompressSync(fs.readFileSync(bundlePath)))

  // id-sets derived from the bundle (for idempotent deletes)
  const ids = (table: string, col: string) => (sections.get(table) ?? []).map((r) => String(r[col]))
  const idSets: Record<IdSet, string[]> = {
    project: meta.projectIds,
    user: ids("users", "id"),
    org: ids("organizations", "id"),
    group: ids("groups", "id"),
    assignment: ids("assignments", "assignment_id"),
  }

  const c = new Client({ connectionString: url, ssl: host.endsWith(".neon.tech") ? { rejectUnauthorized: true } : false })
  await c.connect()
  try {
    console.log(`Loading ${meta.projectIds.length} projects into ${host} …`)
    await assertTargetSchema(c, sections)
    await c.query("BEGIN")
    // delete existing (reverse order; harmless without FKs but tidy)
    for (const t of [...SEED_TABLES].reverse()) {
      const set = idSets[t.by.set]
      if (set.length) await c.query(`DELETE FROM ${t.name} WHERE ${t.by.col} = ANY($1)`, [set])
    }
    // insert forward
    for (const t of SEED_TABLES) {
      const rows = sections.get(t.name) ?? []
      await insertRows(c, t.name, rows)
    }
    // reset identity sequences so dev-created rows don't collide with seeded ids
    for (const t of IDENTITY_SEQ_TABLES) {
      await c.query(`SELECT setval(pg_get_serial_sequence($1,'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}),1),1))`, [t])
    }
    await c.query("COMMIT")

    // verify counts — fail loud on any mismatch
    let bad = 0
    for (const t of SEED_TABLES) {
      const set = idSets[t.by.set]
      const got = set.length ? Number((await c.query(`SELECT count(*)::int AS n FROM ${t.name} WHERE ${t.by.col} = ANY($1)`, [set])).rows[0].n) : 0
      const want = meta.counts[t.name] ?? 0
      if (got !== want) { console.error(`✗ ${t.name}: loaded ${got}, expected ${want}`); bad++ }
    }
    if (bad) throw new Error(`${bad} table(s) failed count verification`)
    console.log(`✓ loaded + verified ${SEED_TABLES.length} tables`)

    // Optional: grant a local user OWNER membership on every seeded org and
    // project so seeded data is visible through both org-scoped dashboards and
    // direct project membership views (seeded rows belong to scrubbed users).
    const grantTo = flagValue("--grant-to")
    if (grantTo) {
      const u = (await c.query(`SELECT id FROM users WHERE username = $1`, [grantTo])).rows[0]
      if (!u) {
        console.warn(`⚠ --grant-to: no user "${grantTo}" in target (boot the app once to create the dev user, then re-run); skipping grant`)
      } else {
        const orgIds = idSets.org
        for (const oid of orgIds) {
          await c.query(
            `INSERT INTO org_members (org_id, user_id, role_level, granted_by, granted_at)
             VALUES ($1, $2, $3, $2, now())
             ON CONFLICT (org_id, user_id) DO UPDATE SET role_level = EXCLUDED.role_level`,
            [oid, u.id, OWNER_ROLE],
          )
        }
        for (const pid of meta.projectIds) {
          await c.query(
            `INSERT INTO project_members (project_id, user_id, role_level, granted_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (project_id, user_id) DO UPDATE SET role_level = EXCLUDED.role_level`,
            [pid, u.id, OWNER_ROLE],
          )
        }
        console.log(`✓ granted ${grantTo} (id ${u.id}) OWNER on ${orgIds.length} seeded orgs and ${meta.projectIds.length} seeded projects`)
      }
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    await c.end()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
