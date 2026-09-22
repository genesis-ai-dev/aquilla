#!/usr/bin/env tsx
// AQU-1240 — verify lane_id population + referential integrity across the eight
// lane-bearing tables. Read-only. Run it as the gate BEFORE the SET NOT NULL
// cutover (db/postgres/deferred-notnull-cutover/) and again after the backfill
// to confirm the environment is clean.
//
// For every table it reports:
//   total    — row count
//   nulls    — rows with lane_id IS NULL (must be 0 before enforcing NOT NULL)
//   orphans  — rows whose non-null (project_id, lane_id) has NO matching lane
//              (must ALWAYS be 0 — a validated FK guarantees this; a non-zero
//              here means the FK was never validated or was bypassed)
//
// Exit code:
//   0  clean (no orphans; and, with --require-complete, no nulls either)
//   1  orphans found, OR --require-complete and nulls remain, OR DB unreachable
//
//   pnpm neon:verify:lanes:dev                     # report only
//   pnpm neon:verify:lanes:dev --require-complete  # gate: fail if any nulls
//   AQUILLA_DATABASE_URL=<local> tsx scripts/neon-verify-lanes.ts   # local
import { makePostgres } from '../db/shim/postgres'

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || 'neondb'
  const role = process.env.NEON_PG_ROLE?.trim() || 'neondb_owner'
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error('NEON_PG_HOST and NEON_PG_PASSWORD are required')
  const url = new URL('postgresql://placeholder')
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set('sslmode', 'require')
  return url.toString()
}

// The eight lane_id-bearing tables (schema.sql / migration 0093). Every one has
// (project_id, lane_id); the composite FK references lanes(project_id, id).
const TABLES = [
  'cells',
  'cell_validators',
  'file_section_progress',
  'assignments',
  'artifact_bindings',
  'scene_briefs',
  'contextual_runs',
  'contextual_drafts',
] as const

type Counts = { total: number; nulls: number; orphans: number }

function countsSql(table: string): string {
  return `SELECT
    (SELECT count(*) FROM ${table}) AS total,
    (SELECT count(*) FROM ${table} WHERE lane_id IS NULL) AS nulls,
    (SELECT count(*) FROM ${table} t
       WHERE t.lane_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM lanes l
            WHERE l.project_id = t.project_id AND l.id = t.lane_id)) AS orphans`
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padNum(n: number, w: number): string {
  const s = n.toLocaleString('en-US')
  return s.length >= w ? s : ' '.repeat(w - s.length) + s
}

async function main(): Promise<void> {
  const requireComplete = process.argv.includes('--require-complete')
  const db = makePostgres(connectionString(), 1)
  let nullTotal = 0
  let orphanTotal = 0
  try {
    const lanesRow = await db
      .prepare(`SELECT count(*) AS n FROM lanes`)
      .all<{ n: number }>()
    const laneCount = Number(lanesRow.results[0]?.n ?? 0)
    console.log(`lanes: ${laneCount.toLocaleString('en-US')} row(s)\n`)

    console.log(
      `${pad('table', 24)} ${pad('total', 12)} ${pad('nulls', 12)} ${pad('orphans', 10)}`,
    )
    console.log('-'.repeat(60))
    for (const table of TABLES) {
      const { results } = await db.prepare(countsSql(table)).all<Counts>()
      const c = results[0] ?? { total: 0, nulls: 0, orphans: 0 }
      const total = Number(c.total)
      const nulls = Number(c.nulls)
      const orphans = Number(c.orphans)
      nullTotal += nulls
      orphanTotal += orphans
      const flag = orphans > 0 ? '  ✗ ORPHANS' : nulls > 0 ? '  • nulls' : '  ✓'
      console.log(
        `${pad(table, 24)} ${padNum(total, 12)} ${padNum(nulls, 12)} ${padNum(orphans, 10)}${flag}`,
      )
    }
    console.log('-'.repeat(60))
    console.log(
      `totals: ${nullTotal.toLocaleString('en-US')} null lane_id, ` +
        `${orphanTotal.toLocaleString('en-US')} orphan(s)\n`,
    )
  } finally {
    await db.close()
  }

  if (orphanTotal > 0) {
    console.error(
      `✗ FAIL: ${orphanTotal} row(s) reference a non-existent lane. The composite ` +
        `FK is not enforcing — do NOT proceed to the NOT NULL cutover.`,
    )
    process.exit(1)
  }
  if (requireComplete && nullTotal > 0) {
    console.error(
      `✗ FAIL (--require-complete): ${nullTotal} row(s) still have a NULL lane_id. ` +
        `Run the backfill (pnpm neon:backfill:lanes:<env> --apply) until this is 0 ` +
        `before enforcing NOT NULL.`,
    )
    process.exit(1)
  }
  console.log(
    requireComplete
      ? '✓ PASS: every lane_id is populated and references a real lane.'
      : '✓ referential integrity clean (no orphans).',
  )
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
