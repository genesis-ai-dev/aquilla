#!/usr/bin/env tsx
// AQU-2357 — Owner rows for projects created between migration 0207 and the
// deploy of the workers that write the Owner row themselves.
//
// 0207 grants Owner to every creator who existed when it ran, and raises a
// lower row to 700. That raise is a one-time correction: the old creator path
// had forced Owner. Running it again would undo a demotion made after release.
//
// This repair is the second run, and it is narrower. It inserts an Owner row
// only when the creator has no project_members row at all, and only for a
// project created at or after 0207 was recorded. A second apply inserts nothing.
//
// Dry-run unless --apply is passed.
//   pnpm neon:repair-creator-owner-grants:dev
//   pnpm neon:repair-creator-owner-grants:prod -- --apply
import { neonClient } from "./pg"

const MIGRATION = "0207_creator_owner_grant.sql"

const MISSING = `
SELECT p.id AS project_id, p.name AS name
  FROM projects p
  JOIN schema_migrations m ON m.name = $1
 WHERE p.created_by IS NOT NULL
   AND p.created_at >= m.applied_at
   AND NOT EXISTS (
     SELECT 1 FROM project_members pm
      WHERE pm.project_id = p.id AND pm.user_id = p.created_by
   )
 ORDER BY p.created_at, p.id`

const INSERT = `
INSERT INTO project_members (project_id, user_id, role_level, granted_by)
SELECT p.id, p.created_by, 700, p.created_by
  FROM projects p
  JOIN schema_migrations m ON m.name = $1
 WHERE p.created_by IS NOT NULL
   AND p.created_at >= m.applied_at
   AND NOT EXISTS (
     SELECT 1 FROM project_members pm
      WHERE pm.project_id = p.id AND pm.user_id = p.created_by
   )
ON CONFLICT (project_id, user_id) DO NOTHING`

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const client = neonClient()
  await client.connect()
  try {
    const recorded = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [MIGRATION])
    if ((recorded.rowCount ?? 0) === 0) {
      console.error(`${MIGRATION} is not recorded on this database. Apply it before the repair.`)
      process.exitCode = 1
      return
    }
    if (!apply) {
      await client.query("BEGIN READ ONLY")
      const rows = await client.query(MISSING, [MIGRATION])
      await client.query("ROLLBACK")
      const count = rows.rowCount ?? rows.rows.length
      console.log(`${count} project(s) would gain an Owner row.`)
      for (const row of rows.rows.slice(0, 20) as { project_id: string; name: string }[]) {
        console.log(`  ${row.project_id}  ${row.name}`)
      }
      if (count > 20) console.log(`  … and ${count - 20} more`)
      console.log("Dry run. Pass --apply to write.")
      return
    }
    await client.query("BEGIN")
    const written = await client.query(INSERT, [MIGRATION])
    await client.query("COMMIT")
    console.log(`Inserted ${written.rowCount ?? 0} Owner row(s).`)
  } catch (err) {
    try {
      await client.query("ROLLBACK")
    } catch {
      // The failed statement already ended the transaction.
    }
    throw err
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
