#!/usr/bin/env tsx
// AQU-2352 — organization roles are Member, Maintainer and Owner. DRY RUN ONLY.
//
// Reads the access tables in a read-only session (it refuses to go on unless
// `SHOW default_transaction_read_only` is `on`) and writes the per-org report:
//
//   * every org_members row at 101–599 that becomes Member;
//   * each person and lane whose role would drop once the AQU-1274 lift is
//     gone, without the compensating grants, and the grant that fixes it;
//   * who loses the org Members page (their org role no longer meets the
//     org's roster floor);
//   * the access diff before vs after migration 0210 (must lose nobody), and
//     the totals, with a cross-check against the counts in AQU-2352;
//   * how many lifted pairs 0210 records in `org_role_lift_grants`, the
//     temporary grants AQU-2354 later removes.
//
// THE WRITE IS MIGRATION 0210 (db/postgres/migrations/0210_org_roles_member_
// maintainer_owner.sql), applied with the other pending migrations by
// `pnpm neon:apply:<target>` (production needs `--snapshot`). This script
// never writes and has no --apply.
//
//   pnpm neon:org-roles:dev -- --out /tmp/aqu-2352-dev.md
//   pnpm neon:org-roles:prod -- --out /tmp/aqu-2352-prod.md
//   AQUILLA_DATABASE_URL=postgres://… tsx scripts/neon-org-roles.ts --out report.md
//
// Flags: --out <markdown file>  --json <file>  --source-note <text>  --snapshot-date <YYYY-MM-DD>
import { writeFileSync } from "node:fs"
import { loadRawAccessTables } from "./lib/access-snapshot"
import { openMigrationConnection } from "./lib/migration-pg"
import { loadOrgRoleExtras } from "./lib/org-roles-plan"
import { buildOrgRolesReport, MIGRATION_NAME } from "./lib/org-roles-report"

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  if (process.argv.includes("--apply")) {
    throw new Error(`this script only reads. The write is migration ${MIGRATION_NAME}: \`pnpm neon:apply:<target>\` (production: --snapshot)`)
  }
  const out = flagValue("--out")
  const jsonOut = flagValue("--json")
  const { client } = await openMigrationConnection({ apply: false })
  try {
    const raw = await loadRawAccessTables(client)
    const extras = await loadOrgRoleExtras(client)
    const report = buildOrgRolesReport(raw, extras, {
      mode: "dry run (read-only session)",
      sourceNote: flagValue("--source-note"),
      snapshotDate: flagValue("--snapshot-date"),
    })
    if (out) writeFileSync(out, report.markdown)
    else console.log(report.markdown)
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report.json, null, 2))
    console.error(
      `[aqu-2352] dry run: ${report.plan.orgRowChanges.length} org row(s) to Member, ${report.plan.lifted.length} lifted pair(s), ` +
        `${report.liftGrantsRecorded} pair(s) the migration records in org_role_lift_grants, ` +
        `${report.unintendedLosses} unintended loss(es), ${report.laneRoleDropsAfter} lane-role drop(s). Nothing written.`,
    )
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
