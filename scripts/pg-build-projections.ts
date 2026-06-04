#!/usr/bin/env tsx
// Stage C, step 3: build projections (cells / cell_validators / files / comments
// + file counters) from the imported events, in Neon.
//
// Bulk fold path: foldProjection() reduces each project's event log to its FINAL
// projection rows in memory (scripts/lib/fold-projection.ts), which we then load
// into Neon with batched multi-row INSERTs — a handful of round-trips per project
// instead of one-per-statement. This is RTT-independent: the heaviest project
// (155k events → 30k cells) goes from ~32 min (serial, 63ms WAN RTT × 30k) to
// seconds. The fold is proven byte-identical to the canonical per-event replay
// (buildEventProjectionStmts) in sync-worker/src/__tests__/fold-projection.test.ts
// and re-checkable on real data here via --verify.
//
//   set -a; . ./.env; set +a
//   npx tsx scripts/pg-build-projections.ts --verify <projectId>  # parity check, writes nothing
//   npx tsx scripts/pg-build-projections.ts --limit 3             # canary build
//   npx tsx scripts/pg-build-projections.ts                       # all projects
//   flags: --only <projectId>  --concurrency N (default 8)
import { Pool, types } from "pg"
import { PGlite } from "@electric-sql/pglite"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { neonConfig } from "./pg"
import { foldProjection, type FoldEvent, type Row } from "./lib/fold-projection"
import { buildEventProjectionStmts, CHAIN_MUTATING_KINDS, type PersistedEvent } from "../sync-worker/src/events/event-projection"
import type { EventKind } from "../sync-worker/src/events/types"
import { D1Postgres, type PgExecutor } from "../db/shim/d1-postgres"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"

types.setTypeParser(20, (v: string) => Number(v)) // int8 → JS number

// Explicit column order per table (multi-row INSERT can't rely on key order).
const CELLS_COLS = [
  "project_id", "file_id", "cell_id", "side", "value", "value_html", "type",
  "canonical_ref", "anchor_cell_id", "event_id", "source_event_id", "last_editor",
  "last_edit_at", "validated", "endorsement_count", "word_count", "content_hash",
  "start_ms", "end_ms", "medium", "sequence_index", "transcription", "camera_state",
]
const VALIDATOR_COLS = ["project_id", "file_id", "cell_id", "event_id", "username", "decided_ts"]
const FILE_COLS = [
  "id", "project_id", "name", "role", "kind", "book_code", "source_file_id",
  "anchor_file_id", "event_id", "cell_count", "approved_count", "word_count",
  "last_edit_at", "created_by", "created_at", "updated_at", "meta",
]
const COMMENT_COLS = [
  "comment_id", "project_id", "scope_kind", "file_id", "cell_id", "parent_comment_id",
  "body", "resolved", "author_id", "author_label", "created_at", "updated_at", "deleted_at",
]
// `comments.comment_id` and `files.id` are GLOBAL primary keys (not project-
// scoped like cells/cell_validators), so an id reused across projects collides
// even after the per-project DELETE. Mirror the canonical conflict handling:
// comment.create is ON CONFLICT(comment_id) DO NOTHING (first writer wins);
// file.create is ON CONFLICT(id) DO NOTHING here (a cross-project file-id clash
// must not let one project clobber another's file row).
const TABLES: Array<{ name: keyof ReturnType<typeof foldProjection>; cols: string[]; conflict?: string }> = [
  { name: "files", cols: FILE_COLS, conflict: "ON CONFLICT (id) DO NOTHING" },
  { name: "cells", cols: CELLS_COLS },
  { name: "cell_validators", cols: VALIDATOR_COLS },
  { name: "comments", cols: COMMENT_COLS, conflict: "ON CONFLICT (comment_id) DO NOTHING" },
]

const PARAM_CAP = 60000 // < PG's 65535 bind-param ceiling

interface EventRow {
  id: string
  project_id: string
  file_id: string | null
  cell_id: string | null
  parent_id: string | null
  kind: string
  author: string
  payload: string
  server_ts: number
  server_seq: number
}

async function fetchEvents(pg: Pool, projectId: string): Promise<FoldEvent[]> {
  const r = await pg.query<EventRow>(
    `SELECT id, project_id, file_id, cell_id, parent_id, kind, author, payload, server_ts, server_seq
       FROM events WHERE project_id = $1 ORDER BY server_seq ASC, server_ts ASC, id ASC`,
    [projectId],
  )
  return r.rows.map((e) => ({
    id: e.id,
    projectId: e.project_id,
    fileId: e.file_id,
    cellId: e.cell_id,
    parentId: e.parent_id,
    kind: e.kind,
    author: e.author,
    payload: JSON.parse(e.payload),
    serverTs: e.server_ts,
    serverSeq: e.server_seq,
  }))
}

async function bulkInsert(client: import("pg").PoolClient, table: string, cols: string[], rows: Row[], conflict = ""): Promise<void> {
  if (rows.length === 0) return
  const rowsPerBatch = Math.max(1, Math.floor(PARAM_CAP / cols.length))
  for (let i = 0; i < rows.length; i += rowsPerBatch) {
    const chunk = rows.slice(i, i + rowsPerBatch)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const ph = cols.map((c) => {
        params.push(row[c] ?? null)
        return `$${params.length}`
      })
      return `(${ph.join(",")})`
    })
    await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")} ${conflict}`, params)
  }
}

const COUNTER_UPDATE = `UPDATE files SET
  cell_count = (SELECT COUNT(DISTINCT cell_id) FROM cells WHERE project_id=files.project_id AND file_id=files.id),
  approved_count = (SELECT COUNT(*) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND validated=1),
  filled_count = (SELECT COUNT(*) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND side='target' AND TRIM(value)!=''),
  word_count = (SELECT COALESCE(SUM(word_count),0) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND side='target'),
  last_edit_at = (SELECT MAX(last_edit_at) FROM cells WHERE project_id=files.project_id AND file_id=files.id),
  updated_at = $1
 WHERE project_id = $2`

// Build one project's projection into Neon: fold → wipe → bulk insert → counters,
// all inside one transaction so a failure leaves the prior projection intact.
async function buildProject(pg: Pool, projectId: string, counterTs: number): Promise<number> {
  const events = await fetchEvents(pg, projectId)
  const rows = foldProjection(events)
  const client = await pg.connect()
  try {
    await client.query("BEGIN")
    for (const t of ["cell_validators", "cells", "comments", "files"]) {
      await client.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId])
    }
    for (const { name, cols, conflict } of TABLES) await bulkInsert(client, name, cols, rows[name], conflict)
    await client.query(COUNTER_UPDATE, [counterTs, projectId])
    await client.query("COMMIT")
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
  return rows.cells.length + rows.cell_validators.length
}

// ── Parity self-check (--verify): replay this project's REAL events through the
// canonical buildEventProjectionStmts on a local PGlite, fold them, and diff.
// Same proof as the unit test, on production data, writing nothing to Neon.
const SCHEMA = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/postgres/schema.sql"),
  "utf8",
)
const VERIFY_COUNTER_TS = 1_700_000_000_000

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

const childKey = (e: FoldEvent) => `${e.projectId}\0${e.fileId ?? ""}\0${e.cellId ?? ""}\0${e.parentId ?? "<null>"}`

async function replayCanonicalInto(pg: PGlite, events: FoldEvent[]): Promise<void> {
  const db = new D1Postgres(pgliteExecutor(pg)) as unknown as D1Database
  const winning = new Map<string, string>()
  const stmts: D1PreparedStatement[] = []
  for (const e of events) {
    // Live-route semantics: guard chain-mutating kinds only (see route.ts).
    if (e.cellId && CHAIN_MUTATING_KINDS.has(e.kind)) {
      const k = childKey(e)
      const w = winning.get(k)
      if (!w) winning.set(k, e.id)
      else if (w !== e.id) continue
    }
    const event: PersistedEvent = {
      id: e.id, schemaVersion: 1, projectId: e.projectId, fileId: e.fileId, cellId: e.cellId,
      parentId: e.parentId, kind: e.kind as EventKind, author: e.author, payload: e.payload,
      clientTs: e.serverTs, serverTs: e.serverTs, serverSeq: e.serverSeq,
    }
    buildEventProjectionStmts(db, event, stmts, { deferFileCounters: true })
  }
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500))
  await pg.query(COUNTER_UPDATE, [VERIFY_COUNTER_TS, events[0]?.projectId])
}

async function insertFoldInto(pg: PGlite, rows: ReturnType<typeof foldProjection>): Promise<void> {
  for (const { name, cols } of TABLES) {
    for (const row of rows[name]) {
      const used = cols.filter((c) => c in row)
      if (used.length === 0) continue
      const ph = used.map((_, i) => `$${i + 1}`).join(",")
      await pg.query(`INSERT INTO ${name} (${used.join(",")}) VALUES (${ph})`, used.map((c) => row[c]))
    }
  }
  await pg.query(COUNTER_UPDATE, [VERIFY_COUNTER_TS, rows.files[0]?.project_id ?? rows.cells[0]?.project_id])
}

const VOLATILE: Record<string, Set<string>> = { files: new Set(["created_at", "updated_at"]) }
function normalize(table: string, rows: Array<Record<string, unknown>>): string {
  const drop = VOLATILE[table] ?? new Set<string>()
  const clean = rows.map((r) => {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(r).sort()) if (!drop.has(k) && k !== "value_tsv") o[k] = r[k]
    return o
  })
  clean.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(clean)
}

async function verifyProject(pg: Pool, projectId: string): Promise<boolean> {
  const events = await fetchEvents(pg, projectId)
  console.log(`verify ${projectId}: ${events.length} events`)
  const ref = new PGlite()
  const fold = new PGlite()
  await ref.exec(SCHEMA)
  await fold.exec(SCHEMA)
  await replayCanonicalInto(ref, events)
  await insertFoldInto(fold, foldProjection(events))
  let ok = true
  for (const table of ["cells", "cell_validators", "files", "comments"]) {
    const a = normalize(table, (await ref.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows)
    const b = normalize(table, (await fold.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows)
    const match = a === b
    ok = ok && match
    const aCount = JSON.parse(a).length
    const bCount = JSON.parse(b).length
    console.log(`  ${match ? "✓" : "✗"} ${table}: canonical=${aCount} fold=${bCount}`)
    if (!match) {
      const aa = JSON.parse(a) as unknown[]
      const bb = JSON.parse(b) as unknown[]
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        if (JSON.stringify(aa[i]) !== JSON.stringify(bb[i])) {
          console.log(`    first diff @${i}:\n      canonical: ${JSON.stringify(aa[i])}\n      fold:      ${JSON.stringify(bb[i])}`)
          break
        }
      }
    }
  }
  await ref.close()
  await fold.close()
  return ok
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

async function main() {
  const a = process.argv.slice(2)
  const val = (f: string) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined)
  const verify = val("--verify")
  const only = val("--only")
  const limit = val("--limit") ? Number(val("--limit")) : undefined
  const concurrency = val("--concurrency") ? Number(val("--concurrency")) : 8

  const pg = new Pool({ ...neonConfig(), max: Math.max(8, concurrency * 2) })

  if (verify) {
    const ok = await verifyProject(pg, verify)
    await pg.end()
    console.log(ok ? "\n✓ PARITY OK" : "\n✗ PARITY FAILED")
    process.exit(ok ? 0 : 1)
  }

  let projects: string[]
  if (only) projects = [only]
  else {
    const r = await pg.query<{ project_id: string }>("SELECT DISTINCT project_id FROM events ORDER BY project_id")
    projects = r.rows.map((x) => x.project_id)
    if (limit) projects = projects.slice(0, limit)
  }
  console.log(`Building projections for ${projects.length} project(s), concurrency ${concurrency}…`)

  const counterTs = Number(process.env.BUILD_COUNTER_TS) || 1_700_000_000_000
  const t0 = Date.now()
  let done = 0
  let failed = 0
  let rowsTotal = 0
  await pool(projects, concurrency, async (pid) => {
    try {
      rowsTotal += await buildProject(pg, pid, counterTs)
      done++
      if (done % 10 === 0) console.log(`  …${done}/${projects.length}  ${rowsTotal} rows  ${Math.round((Date.now() - t0) / 1000)}s`)
    } catch (e) {
      failed++
      console.error(`  ✗ ${pid}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  await pg.end()
  const secs = (Date.now() - t0) / 1000
  console.log(`\n✓ ${done}/${projects.length} projects, ${rowsTotal} projection rows, ${failed} failed, ${secs.toFixed(1)}s`)
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
