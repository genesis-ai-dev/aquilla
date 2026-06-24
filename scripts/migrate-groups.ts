#!/usr/bin/env tsx
// GitLab group tree → Aquilla org/team/member import (Layer A), now Neon-backed.
//
// Walks the GitLab group tree, resolves members to aquilla users, and upserts
// orgs / org_members / groups / group_members into NEON via the trusted
// /migrate/groups + /migrate/users endpoints (gated on SYNC_SECRET_KEY). The
// gather+plan+upsert lives in src/lib/migrate/group-sync (shared with the
// content sweep, which now does this inline — so a delta fully pulls in new
// orgs). Idempotent: orgs/teams dedup on legacy_uuid, members on their PKs.
//
// Was D1-direct (`wrangler d1 execute aquilla-db`); that D1 is a frozen
// pre-cutover snapshot, so this is the completed D1→Neon cutover for Layer A.
//
//   set -a; . ./.env; set +a
//   npx tsx scripts/migrate-groups.ts            # dry-run: read + plan, no writes
//   npx tsx scripts/migrate-groups.ts --apply    # upsert to Neon (prod)
//
// Auth: GitLab via FRONTIER_USERNAME+FRONTIER_PASSWORD (or FRONTIER_TOKEN+
// GITLAB_URL); Neon writes via SYNC_SECRET_KEY against SYNC_BASE.

import { resolveCredentialsFromEnv } from "../src/lib/migrate/gitlab/auth"
import { syncGroupsToNeon } from "../src/lib/migrate/group-sync"

const SYNC = process.env.SYNC_BASE ?? "https://api.aquilla.app/sync"

function authHeaders(): Record<string, string> {
  const secret = process.env.SYNC_SECRET_KEY
  if (!secret) throw new Error("SYNC_SECRET_KEY not set (load .env: `set -a; . ./.env; set +a`)")
  return { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }
}

async function main() {
  const apply = process.argv.includes("--apply")
  console.log("Authenticating to GitLab…")
  const creds = await resolveCredentialsFromEnv()
  console.log(`  GitLab: ${creds.gitlabUrl}  →  Neon via ${SYNC}   ${apply ? "APPLY" : "dry-run"}`)

  const gs = await syncGroupsToNeon(creds, { syncBase: SYNC, headers: authHeaders() }, { apply })
  const p = gs.plan

  console.log(
    `\nPlan → orgs ${p.orgs.length}, org_members ${p.orgMembers.length}, ` +
      `teams ${p.teams.length}, team_members ${p.teamMembers.length}, conflicts ${p.conflicts.length}`,
  )
  if (p.conflicts.length) {
    const byKind = new Map<string, number>()
    for (const c of p.conflicts) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1)
    console.log("  conflicts:", Object.fromEntries(byKind))
    const names = new Map<string, number>()
    for (const c of p.conflicts) {
      if (c.kind !== "unresolved-user") continue
      const m = c.detail.match(/^@(\S+)/)
      if (m) names.set(m[1], (names.get(m[1]) ?? 0) + 1)
    }
    const sorted = [...names.entries()].sort((a, b) => b[1] - a[1])
    if (sorted.length) {
      console.log(`  distinct unresolved usernames (${sorted.length}):`)
      for (const [n, count] of sorted) console.log(`    @${n}  ×${count}`)
    }
    for (const c of p.conflicts.filter((c) => c.kind === "no-owner")) console.log(`    [no-owner] ${c.detail}`)
  }

  if (apply) {
    console.log(`\n✓ Upserted to Neon — ${gs.orgIdByUuid.size} orgs, ${gs.teamIdByUuid.size} teams resolved.`)
    console.log("  (re-run to confirm convergence — idempotent.)")
  } else {
    console.log("\n[dry-run] no writes. Re-run with --apply to upsert to Neon.")
  }
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
