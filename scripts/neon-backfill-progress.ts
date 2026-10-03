#!/usr/bin/env tsx
import { makePostgres } from '../db/shim/postgres'
import {
  fullProgressRecomputeStmts,
  UNREFERENCED_LINES_STALE_FILES_SQL,
} from '../sync-worker/src/events/progress-projection'

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
    // AQU-1093/1098: `--missing-books` re-runs only files whose projection
    // predates book rows / audio counts. Three ways to be stale: no file row at
    // all; Scripture with no book row; or live takes on disk while the file row
    // still reports zero audio. That third clause matters — a dubbing file is
    // not Scripture and does have a file row, so without it the selector calls
    // every media project done while its audio counts sit at zero forever.
    // Lets the post-deploy backfill be resumed without redoing the whole DB.
    const missingBooks = process.argv.includes('--missing-books')
    // AQU-1493: `--unreferenced-lines` re-runs Scripture files whose stored
    // line placements (`cell_plan_keys`, migration 0130) are not what the
    // projection would place now. A line with no reference used to count in
    // the file and in no chapter or book; an added line now counts in the
    // chapter of the line above it (front matter at the top of the file), a
    // heading in the chapter of the verse below it, and a book's title on its
    // front matter. The full recompute writes those placements and every
    // progress row counted from them together. The selector walks only files
    // holding a line with no reference and compares the walk with the stored
    // rows cell by cell, so before the first run it picks every such file and
    // afterwards none: safe to re-run. Combines with --missing-books (the dev
    // stack passes both at boot). It starts with WITH, hence the parentheses
    // in the UNION below.
    // Production: apply migration 0130, deploy, then
    // `pnpm neon:backfill:progress:prod --unreferenced-lines` once (`:dev` for
    // the preview database).
    const unreferencedLines = process.argv.includes('--unreferenced-lines')
    const scoped = missingOnly || missingBooks || unreferencedLines
    const unreferencedSql = UNREFERENCED_LINES_STALE_FILES_SQL
    const { results: files } = await db
      .prepare(unreferencedLines && !missingBooks
        ? `${unreferencedSql}
            ORDER BY project_id, id`
        : missingBooks
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
               OR (
                 EXISTS (
                   SELECT 1 FROM cell_audio ca
                    WHERE ca.project_id = f.project_id AND ca.file_id = f.id
                      AND ca.deleted = 0
                 )
                 AND EXISTS (
                   SELECT 1 FROM file_section_progress p3
                    WHERE p3.project_id = f.project_id AND p3.file_id = f.id
                      AND p3.scope = 'file' AND p3.audio_count = 0
                 )
               )
            ${unreferencedLines ? `UNION (${unreferencedSql})` : ''}
            ORDER BY 1, 2`
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
