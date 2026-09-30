#!/usr/bin/env tsx
// AQU-1296 — comment projection reconciliation check.
//
// Asserts the invariant that every `comment.create` event has a `comments` row
// IN ITS OWN PROJECT. This is the guard the bug needed and did not have: when
// `comments.comment_id` was a global primary key, a second project emitting an
// id another project already owned had its insert swallowed by
// `ON CONFLICT(comment_id) DO NOTHING`. The event landed in the log, the row
// never appeared, and nothing anywhere logged it — 3,348 rows across ~20
// projects stayed invisible for three months until a team reported "comments
// disappearing". Silence was the whole failure mode, so this check exits
// non-zero and names the projects.
//
//   set -a; . ./.env; set +a
//   npm run db:check:comments                       # the bound database
//   npx tsx scripts/check-comment-projection.ts     # same thing
//
// Exits 0 when the invariant holds, 1 when any project has invisible comments,
// 2 when the check itself could not run (no creds, connection refused) — an
// unrunnable check must never read as a pass.
import { pathToFileURL } from "node:url"
import { neonClient } from "./pg"

/** The reconciliation invariant from AQU-1296. Must return zero rows. */
const INVARIANT_SQL = `
  SELECT project_id, count(*)::int AS invisible
    FROM events e
   WHERE e.kind = 'comment.create'
     AND NOT EXISTS (SELECT 1 FROM comments c
                      WHERE c.comment_id = e.payload::json->>'commentId'
                        AND c.project_id = e.project_id)
   GROUP BY 1
  HAVING count(*) > 0
   ORDER BY 2 DESC`

interface InvisibleRow {
  project_id: string
  invisible: number
}

export function formatReport(rows: readonly InvisibleRow[]): string {
  if (rows.length === 0) {
    return "✓ comment projection reconciled — every comment.create event has a row in its own project"
  }
  const total = rows.reduce((n, r) => n + r.invisible, 0)
  const lines = [
    `✗ ${total} comment.create event(s) across ${rows.length} project(s) have NO comments row in their own project.`,
    "",
    "  project_id                            invisible",
    "  ------------------------------------  ---------",
    ...rows.map((r) => `  ${r.project_id.padEnd(36)}  ${String(r.invisible).padStart(9)}`),
    "",
    "The events are the source of truth, so every one of these rows is recoverable:",
    "re-project the affected projects (scripts/pg-build-projections.ts --only <projectId>).",
    "If this fires on a database that already has migration 0093 applied, the cause is a",
    "NEW writer matching on comment_id without its project — find it before re-homing rows.",
  ]
  return lines.join("\n")
}

async function main(): Promise<void> {
  const client = neonClient()
  await client.connect()
  try {
    const { rows } = await client.query<InvisibleRow>(INVARIANT_SQL)
    console.log(formatReport(rows))
    process.exitCode = rows.length === 0 ? 0 : 1
  } finally {
    await client.end()
  }
}

// Entrypoint guard (same shape as scripts/check-app-build.ts) so the formatter
// stays unit-testable without a database.
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error("comment projection check could not run:", err instanceof Error ? err.message : err)
    // Exit 2, not 1: "I could not check" is not "the invariant holds".
    process.exitCode = 2
  })
}
