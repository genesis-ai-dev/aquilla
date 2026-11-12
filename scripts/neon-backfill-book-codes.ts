#!/usr/bin/env tsx
// AQU-1196: one-off backfill of `files.book_code` for legacy-Codex Scripture
// files.
//
// The migrator used to emit `file.create` with no `bookCode`, so every file in
// a migrated partner project (Xiang Loudi and the other `legacy-import`
// projects) landed with `book_code = NULL`. The SPA works around that at
// display time by reading a code off the file name, but the column is what
// re-import collision matching, the sidebar's OT/NT grouping and any
// server-side rollup should rely on. `src/lib/migrate/map.ts` now stamps the
// code on new migrations; this fills in the files that predate that.
//
// The rule is `legacyBookCodeFor` — shared with the migrator so the two cannot
// drift. A migrated file is named by its `.codex` basename stem, so only a stem
// that IS an exact USFM book code ("1CH", "MAT") counts; `intro`, notes and any
// other paratext are left alone.
//
// Only `kind = 'codex'` rows with `book_code IS NULL` are touched, so an
// existing value is never overwritten and the backfill is safe to re-run.
//
// DRY RUN BY DEFAULT — prints the rows it would change and writes nothing.
// Pass --apply to write.
//
//   pnpm neon:backfill:book-codes:dev            # dry run against dev
//   pnpm neon:backfill:book-codes:dev --apply    # write to dev
//   pnpm neon:backfill:book-codes:prod           # dry run against prod
//   pnpm neon:backfill:book-codes:prod --apply   # write to prod
//
// Flags: --apply  --verbose
import { makeMaintenancePostgres } from '../db/shim/postgres'
import { legacyBookCodeFor } from '../src/lib/migrate/map'

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

interface CandidateRow {
  id: string
  project_id: string
  name: string
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const verbose = process.argv.includes('--verbose')
  const db = makeMaintenancePostgres(connectionString(), 1)
  try {
    const before = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                COUNT(book_code) AS with_code
           FROM files
          WHERE kind = 'codex'`,
      )
      .first<{ total: number; with_code: number }>()
    console.log(
      `before: ${Number(before?.with_code ?? 0)}/${Number(before?.total ?? 0)} codex files carry book_code`,
    )

    // Candidates come back by name so the book-code rule stays in TypeScript —
    // one rule, shared with the migrator, rather than a second copy in SQL.
    const { results: candidates } = await db
      .prepare(
        `SELECT id, project_id, name
           FROM files
          WHERE kind = 'codex' AND book_code IS NULL
          ORDER BY project_id, name`,
      )
      .all<CandidateRow>()

    const planned: Array<CandidateRow & { bookCode: string }> = []
    let skipped = 0
    for (const row of candidates) {
      const bookCode = legacyBookCodeFor(row.name)
      if (!bookCode) {
        skipped++
        if (verbose) console.log(`  skip  ${row.project_id} ${row.name} (not a book code)`)
        continue
      }
      planned.push({ ...row, bookCode })
    }

    const byCode = new Map<string, number>()
    for (const row of planned) byCode.set(row.bookCode, (byCode.get(row.bookCode) ?? 0) + 1)
    console.log(
      `${candidates.length} codex files with no book_code: ${planned.length} resolve to a book, ${skipped} left untouched`,
    )
    for (const [code, n] of [...byCode].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${code}: ${n}`)
    }
    if (verbose) {
      for (const row of planned) console.log(`  set   ${row.project_id} ${row.name} -> ${row.bookCode}`)
    }

    if (!apply) {
      console.log('dry run: nothing written. Re-run with --apply to write.')
      return
    }

    let written = 0
    for (const row of planned) {
      // `book_code IS NULL` in the predicate as well as the selector: an
      // existing value is never overwritten, even if one landed between the
      // read above and this write.
      const res = await db
        .prepare(
          `UPDATE files
              SET book_code = ?, updated_at = (extract(epoch from now()) * 1000)::bigint
            WHERE id = ? AND project_id = ? AND book_code IS NULL`,
        )
        .bind(row.bookCode, row.id, row.project_id)
        .run()
      written += res.meta.changes
      if (written % 500 === 0) console.log(`book_code backfill: ${written}/${planned.length} files`)
    }

    const after = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                COUNT(book_code) AS with_code
           FROM files
          WHERE kind = 'codex'`,
      )
      .first<{ total: number; with_code: number }>()
    console.log(
      `after: ${Number(after?.with_code ?? 0)}/${Number(after?.total ?? 0)} codex files carry book_code (${written} written)`,
    )
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
