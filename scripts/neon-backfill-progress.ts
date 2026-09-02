#!/usr/bin/env tsx
import { makePostgres } from '../db/shim/postgres'
import { fullProgressRecomputeStmts } from '../sync-worker/src/events/progress-projection'

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
    const missingOnly = process.argv.includes('--missing-only')
    // AQU-1093: `--missing-books` re-runs only files whose projection predates
    // book rows / audio counts. A Scripture file is stale when it has no book
    // row at all; every file is stale when it has no file row. Lets the
    // post-deploy backfill be resumed or re-run without redoing the whole DB.
    const missingBooks = process.argv.includes('--missing-books')
    const scoped = missingOnly || missingBooks
    const { results: files } = await db
      .prepare(missingBooks
        ? `SELECT f.project_id, f.id
             FROM files f
            WHERE NOT EXISTS (
              SELECT 1 FROM file_section_progress p
               WHERE p.project_id = f.project_id AND p.file_id = f.id
                 AND p.scope = 'file' AND p.section_key = ''
            )
               OR (
                 EXISTS (
                   SELECT 1 FROM cells c
                    WHERE c.project_id = f.project_id AND c.file_id = f.id
                      AND c.side = 'source'
                      AND COALESCE(c.canonical_ref, '') ~ '^\\S+ \\d+:\\d+'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM file_section_progress p2
                    WHERE p2.project_id = f.project_id AND p2.file_id = f.id
                      AND p2.scope = 'book'
                 )
               )
            ORDER BY f.project_id, f.id`
        : missingOnly
        ? `SELECT f.project_id, f.id
             FROM files f
            WHERE NOT EXISTS (
              SELECT 1 FROM file_section_progress p
               WHERE p.project_id = f.project_id AND p.file_id = f.id
                 AND p.scope = 'file' AND p.section_key = ''
            )
            ORDER BY f.project_id, f.id`
        : 'SELECT project_id, id FROM files ORDER BY project_id, id')
      .all<{ project_id: string; id: string }>()
    if (files.length === 0 && scoped) return
    let completed = 0
    for (const file of files) {
      const now = Date.now()
      // One short transaction per file. The project sequence-row lock is the
      // same serialization point event writes use, so the snapshot cannot race
      // a live projection update for this project.
      await db.batch([
        db.prepare(
          `INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq)
           SELECT ?, COALESCE(MAX(server_seq), 0), 0 FROM events WHERE project_id = ?
           ON CONFLICT (project_id) DO NOTHING`,
        ).bind(file.project_id, file.project_id),
        db.prepare('SELECT project_id FROM project_seq_counters WHERE project_id = ? FOR UPDATE')
          .bind(file.project_id),
        ...fullProgressRecomputeStmts(db, file.project_id, file.id, now),
      ])
      completed++
      if (completed % 100 === 0 || completed === files.length) {
        console.log(`progress backfill: ${completed}/${files.length} files`)
      }
    }
    console.log(`progress backfill complete: ${completed} files`)
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
