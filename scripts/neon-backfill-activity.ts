#!/usr/bin/env tsx
// One-off backfill of `user_activity_days` (retention rollup, migration 0090)
// from history that predates the rollup:
//   1. events — one row per (author, UTC day), per project so the
//      (project_id, server_ts) index is used instead of a 28GB scan. The
//      legacy-import mirror is skipped; authors are matched to users by
//      username (what the SPA stamps) or by id (what ImportContext documents).
//   2. activity_logs 'login' rows — sign-ins are activity even without an edit.
//   3. org_members.last_active_at — the latest "used the app" day per user.
// Idempotent (ON CONFLICT DO NOTHING); safe to re-run. Going forward the row
// is written live by auth-worker bumpOrgActivity, so this only ever needs to
// run once per database.
//
// Run through the target wrapper so credentials resolve the usual way:
//   pnpm neon:backfill:activity:dev
//   pnpm neon:backfill:activity:prod
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

async function main(): Promise<void> {
  const db = makePostgres(connectionString(), 1)
  try {
    const { results: projects } = await db
      .prepare('SELECT id FROM projects ORDER BY id')
      .all<{ id: string }>()
    let done = 0
    for (const p of projects) {
      await db
        .prepare(
          `INSERT INTO user_activity_days (user_id, day)
           SELECT u.id, (to_timestamp(e.server_ts / 1000.0) AT TIME ZONE 'UTC')::date
             FROM events e
             JOIN users u ON u.username = e.author OR u.id::text = e.author
            WHERE e.project_id = ? AND e.author <> 'legacy-import'
            GROUP BY 1, 2
           ON CONFLICT DO NOTHING`,
        )
        .bind(p.id)
        .run()
      done++
      if (done % 50 === 0 || done === projects.length) {
        console.log(`activity backfill: ${done}/${projects.length} projects`)
      }
    }

    await db
      .prepare(
        `INSERT INTO user_activity_days (user_id, day)
         SELECT a.user_id, (a.timestamp AT TIME ZONE 'UTC')::date
           FROM activity_logs a
           JOIN users u ON u.id = a.user_id
          WHERE a.activity_type = 'login' AND a.timestamp IS NOT NULL
          GROUP BY 1, 2
         ON CONFLICT DO NOTHING`,
      )
      .run()
    await db
      .prepare(
        `INSERT INTO user_activity_days (user_id, day)
         SELECT m.user_id, (m.last_active_at AT TIME ZONE 'UTC')::date
           FROM org_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.last_active_at IS NOT NULL
          GROUP BY 1, 2
         ON CONFLICT DO NOTHING`,
      )
      .run()

    const total = await db
      .prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users, MIN(day) AS first FROM user_activity_days')
      .first<{ n: number; users: number; first: string }>()
    console.log(`activity backfill complete: ${total?.n} user-days across ${total?.users} users, from ${total?.first}`)
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
