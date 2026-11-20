#!/usr/bin/env tsx
// AQU-2355 — a lane grant lists its lanes. DRY RUN BY DEFAULT.
//
// Reads the access tables, works out today's access (role, readable lanes,
// whether later lanes reach them) and the access once AQU-2355 is in, and
// writes the per-org report: who loses (must be nobody), who gains, who stops
// receiving later lanes, and every row the write adds.
//
// The dry run opens a read-only session and refuses to continue unless
// `SHOW default_transaction_read_only` is `on`.
//
// THE WRITE IS MIGRATION 0208 (db/postgres/migrations/0208_team_attachments_
// list_their_lanes.sql). It runs one of two ways, and both record it in
// `schema_migrations`, so it never runs twice:
//
//   * `pnpm neon:apply:<target>` with the other pending migrations (production
//     needs `--snapshot`; a production deploy fails closed while it is pending);
//   * this script with `--apply` (local and dev only — production is refused
//     here and goes through the snapshot guard), which re-reads the tables,
//     re-plans, refuses if the plan loses anyone access, then applies exactly
//     that file through the helper neon-migrate uses (neon-migration-file.ts).
//
//   pnpm neon:explicit-lane-grants:dev -- --out /tmp/aqu-2355-dev.md
//   pnpm neon:explicit-lane-grants:prod -- --out /tmp/aqu-2355-prod.md
//   AQUILLA_DATABASE_URL=postgres://… tsx scripts/neon-explicit-lane-grants.ts --out report.md
//
// Flags: --apply  --out <markdown file>  --json <file>  --source-note <text>
import { readFileSync, writeFileSync } from "node:fs"
import { diffAccess, renderAccessReportMarkdown, renderContext } from "./lib/access-report"
import { AQU_1781_RULE, AQU_2355_RULE, computeAccess, loadRawAccessTables, type RawAccessTables } from "./lib/access-snapshot"
import {
  applyPlanToRaw,
  ddCrossCheck,
  planExplicitLaneGrants,
  planGrantsAdded,
  type ExplicitLaneGrantsPlan,
} from "./lib/explicit-lane-grants-plan"
import { openMigrationConnection } from "./lib/migration-pg"
import { applyMigrationFile } from "./neon-migration-file"

const MIGRATION_NAME = "0208_team_attachments_list_their_lanes.sql"

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function ddAppendix(raw: RawAccessTables): string {
  const dd = ddCrossCheck(raw)
  const lines = [
    "## Appendix: AQU-2351 D-d cross-check",
    "",
    "Direct project grants (`project_members`) on live projects, creators left out. " +
      "\"Every lane, forever\" here means what the code did: no `kind='lane'` scope row and a grant on every other target lane " +
      "(archived included), so `grantNewLaneStmt` (AQU-1781) handed them each new lane.",
    "",
    "| Direct role | Grants | Every lane, forever | Walled | …on one-lane projects | …on 2+ lane projects | …on lane-less projects |",
    "|---|---|---|---|---|---|---|",
  ]
  for (const b of dd.byBucket) {
    lines.push(
      `| ${b.bucket} | ${b.grants} | ${b.everyLaneForever} | ${b.walled} | ${b.oneLaneProjects} | ${b.multiLaneProjects} | ${b.noLaneProjects} |`,
    )
  }
  lines.push("")
  for (const b of dd.byBucket) {
    const orgs = Object.entries(b.multiLaneByOrg).sort((x, y) => y[1] - x[1])
    if (orgs.length === 0) continue
    lines.push(`- ${b.bucket}, 2+ lane projects by org: ${orgs.map(([n, c]) => `${n} ${c}`).join(", ")}`)
  }
  lines.push("")
  lines.push(
    "Other readings of \"every lane\", for comparing with earlier counts: " +
      `no lane scope row — ${Object.entries(dd.noScopeRow).map(([k, v]) => `${k}: ${v}`).join(", ")}; ` +
      `holds a grant on every current lane — ${Object.entries(dd.holdsEveryCurrentLane).map(([k, v]) => `${k}: ${v}`).join(", ")}.`,
    "",
  )
  return lines.join("\n")
}

function buildReport(raw: RawAccessTables, plan: ExplicitLaneGrantsPlan, mode: string, sourceNote?: string): { markdown: string; json: unknown; unintendedLosses: number } {
  const before = computeAccess(raw, AQU_1781_RULE)
  const after = computeAccess(applyPlanToRaw(raw, plan), AQU_2355_RULE)
  const grantsAdded = planGrantsAdded(raw, plan)
  const report = diffAccess({ title: "AQU-2355 dry run: a lane grant lists its lanes", before, after, grantsAdded })
  const archivedLinks = plan.teamLinks.filter((t) => t.projectArchived).length
  const intro = [
    `Mode: **${mode}**. Generated ${new Date().toISOString()}.` + (sourceNote ? ` Data: ${sourceNote}` : ""),
    "",
    "**Before:** " + AQU_1781_RULE.name + ". **After:** " + AQU_2355_RULE.name + ".",
    "",
    "Role is the live resolver's max-wins (direct, team attachment, org Maintainer+ or the AQU-1274 lift, creator); team-member roles are not read (AQU-2454); platform admins are not modelled. " +
      "Readable lanes are the read wall's: every current lane at Maintainer+, otherwise the lane-grant rows at Viewer or above. Live projects only.",
    "",
    `The apply writes ${plan.teamLinks.length} team attachment(s) from \`lanes_explicit = false\` to explicit` +
      (archivedLinks ? ` (${archivedLinks} on archived projects, not shown below)` : "") +
      ` and ${plan.teamLinks.reduce((n, t) => n + t.laneIds.length, 0)} \`group_project_lanes\` row(s) (migration ${MIGRATION_NAME}). It writes no lane-grant row and deletes nothing.`,
  ].join("\n")
  const ctx = renderContext(before, after)
  const markdown = renderAccessReportMarkdown(report, ctx, { intro, appendix: ddAppendix(raw) })
  return { markdown, json: { report, plan }, unintendedLosses: report.totals.unintendedLosses }
}

async function main() {
  const apply = process.argv.includes("--apply")
  const out = flagValue("--out")
  const jsonOut = flagValue("--json")
  const sourceNote = flagValue("--source-note")
  if (apply && process.env.AQUILLA_NEON_TARGET === "production") {
    // Production takes the guarded path: a snapshot branch first (AQU-1877).
    throw new Error(`refusing --apply on production: run \`pnpm neon:apply:prod --snapshot\`, which applies ${MIGRATION_NAME}`)
  }
  const { client } = await openMigrationConnection({ apply })
  try {
    const raw = await loadRawAccessTables(client)
    const plan = planExplicitLaneGrants(raw)
    const { markdown, json, unintendedLosses } = buildReport(
      raw,
      plan,
      apply ? "apply" : "dry run (read-only session)",
      sourceNote,
    )
    if (out) writeFileSync(out, markdown)
    else if (!apply) console.log(markdown)
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(json, null, 2))
    if (!apply) {
      console.error(
        `[aqu-2355] dry run: ${plan.teamLinks.length} attachment(s) to convert, ${unintendedLosses} unintended loss(es). Nothing written.`,
      )
      return
    }
    if (unintendedLosses > 0) {
      throw new Error(`refusing to apply: the plan loses access for ${unintendedLosses} person-project pair(s)`)
    }
    const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [MIGRATION_NAME])
    if ((done.rowCount ?? 0) > 0) {
      console.error(`[aqu-2355] ${MIGRATION_NAME} is already applied here. Nothing written.`)
      return
    }
    const sql = readFileSync(new URL(`../db/postgres/migrations/${MIGRATION_NAME}`, import.meta.url), "utf8")
    await applyMigrationFile(client, MIGRATION_NAME, sql)
    const left = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM group_project_grants WHERE lanes_explicit = false`)
    console.error(
      `[aqu-2355] applied ${MIGRATION_NAME}: ${plan.teamLinks.length} attachment(s) converted; ${left.rows[0]?.n ?? "?"} left with lanes_explicit = false.`,
    )
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
