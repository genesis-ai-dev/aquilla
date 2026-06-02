#!/usr/bin/env tsx
// GitLab group tree → Aquilla org/team/member import (Layer A of the GitLab
// migration: structure + people only; project content + group_project_grants
// come in a later pass once a trusted prod ingest path exists).
//
// Reads the GitLab group tree over the REST API (via brokered Frontier creds),
// resolves members to existing aquilla-db users by username, plans the import
// (src/lib/migrate/groups.ts — pure, unit-tested), and writes orgs / org_members
// / groups / group_members directly to aquilla-db via `wrangler d1` (same
// mechanism as migrate-users.ts). Idempotent: orgs/teams dedup on the
// deterministic legacy_uuid, members on their composite PK.
//
//   npx tsx scripts/migrate-groups.ts                          # read + report (safe)
//   npx tsx scripts/migrate-groups.ts --target remote          # + show the plan vs PROD
//   npx tsx scripts/migrate-groups.ts --target remote --apply  # WRITE to PROD aquilla-db
//   npx tsx scripts/migrate-groups.ts --target local --apply   # WRITE to local dev D1
//
// Auth: GitLab via FRONTIER_USERNAME+FRONTIER_PASSWORD (or FRONTIER_TOKEN+
// GITLAB_URL). DB via your existing `wrangler login`. NOTE: --target local
// contends with a running `pnpm dev` (stop it first).

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveCredentialsFromEnv } from "../src/lib/migrate/gitlab/auth"
import {
  listTopLevelGroups,
  listDescendantGroups,
  listGroupMembers,
  listAllUsers,
} from "../src/lib/migrate/gitlab/api"
import {
  planGroupImport,
  type GitLabSubgroupNode,
  type ResolvedMember,
  type GroupImportPlan,
} from "../src/lib/migrate/groups"

const AQUILLA_DB = "aquilla-db"
const PERSIST = ".wrangler-dev-state"

function d1<T>(sql: string, remote: boolean): T[] {
  const args = ["d1", "execute", AQUILLA_DB, remote ? "--remote" : "--local", "--json"]
  if (!remote) args.push("--persist-to", PERSIST)
  args.push("--command", sql)
  const out = execFileSync("wrangler", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })
  const start = out.indexOf("[")
  if (start < 0) throw new Error(`unexpected wrangler output: ${out.slice(0, 200)}`)
  return (JSON.parse(out.slice(start)) as Array<{ results: T[] }>)[0]?.results ?? []
}

function runSqlFile(sql: string, remote: boolean): void {
  const tmp = path.join(os.tmpdir(), `migrate-groups-${process.pid}.sql`)
  fs.writeFileSync(tmp, sql)
  const args = ["d1", "execute", AQUILLA_DB, remote ? "--remote" : "--local", "--file", tmp]
  if (!remote) args.push("--persist-to", PERSIST)
  execFileSync("wrangler", args, { stdio: "inherit" })
  fs.unlinkSync(tmp)
}

const s = (v: string | null | undefined): string => `'${(v ?? "").replace(/'/g, "''")}'`
const lc = (v: string): string => v.trim().toLowerCase()

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes("--apply")
  const ti = argv.indexOf("--target")
  const remote = (ti >= 0 ? argv[ti + 1] : undefined) === "remote"
  const hasTarget = ti >= 0

  console.log("Authenticating to GitLab…")
  const creds = await resolveCredentialsFromEnv()
  console.log(`  GitLab: ${creds.gitlabUrl}`)

  console.log("Reading group tree…")
  const tops = await listTopLevelGroups(creds)
  console.log(`  ${tops.length} top-level groups`)

  const subgroups: GitLabSubgroupNode[] = []
  const membersByGroupId = new Map<number, ResolvedMember[]>()
  const rawMembersByGroupId = new Map<number, { id: number; username: string; access_level: number }[]>()

  const collect = async (groupId: number) => {
    const ms = await listGroupMembers(creds, groupId)
    rawMembersByGroupId.set(
      groupId,
      ms.map((m) => ({ id: m.id, username: m.username, access_level: m.access_level })),
    )
  }

  for (const top of tops) {
    await collect(top.id)
    const descendants = await listDescendantGroups(creds, top.id)
    for (const d of descendants) {
      subgroups.push({ id: d.id, name: d.name, full_path: d.full_path, topLevelId: top.id })
      await collect(d.id)
    }
  }
  console.log(`  ${subgroups.length} subgroups, ${rawMembersByGroupId.size} groups with members read`)

  // Resolve GitLab members → aquilla user ids. EMAIL is the reliable key:
  // GitLab usernames drifted from Frontier usernames, but emails match. Fall
  // back to username only when email can't resolve. Email comes from the admin
  // /users listing (the members API omits it).
  console.log("Reading GitLab users (for emails)…")
  const glUsers = await listAllUsers(creds)
  const emailByGitlabId = new Map<number, string>()
  for (const u of glUsers) if (u.email) emailByGitlabId.set(u.id, lc(u.email))
  console.log(`  ${glUsers.length} GitLab users, ${emailByGitlabId.size} with email`)

  const dbTarget = hasTarget ? remote : true // default: read PROD for the report
  const users = d1<{ id: number; username: string; email: string }>(
    "SELECT id, username, email FROM users",
    dbTarget,
  )
  const idByEmail = new Map<string, number>()
  const idByName = new Map<string, number>()
  for (const u of users) {
    if (u.email) idByEmail.set(lc(u.email), u.id)
    if (u.username) idByName.set(lc(u.username), u.id)
  }
  console.log(`  ${users.length} aquilla users available for matching (${dbTarget ? "remote" : "local"})`)

  const resolve = (m: { id: number; username: string }): number | null => {
    const email = emailByGitlabId.get(m.id)
    if (email && idByEmail.has(email)) return idByEmail.get(email)!
    return idByName.get(lc(m.username)) ?? null
  }

  for (const [gid, ms] of rawMembersByGroupId) {
    membersByGroupId.set(
      gid,
      ms.map((m) => ({ userId: resolve(m), username: m.username, access_level: m.access_level })),
    )
  }

  // Existing legacy_uuids for idempotency.
  const existingOrgs = d1<{ legacy_uuid: string }>(
    "SELECT legacy_uuid FROM organizations WHERE legacy_uuid IS NOT NULL",
    dbTarget,
  )
  const existingTeams = d1<{ legacy_uuid: string }>(
    "SELECT legacy_uuid FROM groups WHERE legacy_uuid IS NOT NULL",
    dbTarget,
  )

  const plan = planGroupImport({
    topGroups: tops.map((t) => ({ id: t.id, name: t.name, full_path: t.full_path })),
    subgroups,
    membersByGroupId,
    existing: {
      orgUuids: new Set(existingOrgs.map((o) => o.legacy_uuid)),
      teamUuids: new Set(existingTeams.map((t) => t.legacy_uuid)),
    },
  })

  report(plan)

  if (!hasTarget) {
    console.log("\n[no --target] GitLab read only. Re-run with --target local|remote for the DB plan.")
    return
  }
  if (!apply) {
    console.log("\n[dry-run] no writes. Re-run with --apply to write.")
    return
  }

  console.log(`\n${remote ? "⚠️  WRITING TO PROD aquilla-db" : "Writing to local dev aquilla-db"}…`)
  applyPlan(plan, remote)
  console.log("✓ Done. Re-run without --apply to confirm convergence (0 new rows).")
}

function report(plan: GroupImportPlan): void {
  console.log(
    `\nPlan → orgs +${plan.orgs.length}, org_members ${plan.orgMembers.length}, ` +
      `teams +${plan.teams.length}, team_members ${plan.teamMembers.length}, ` +
      `conflicts ${plan.conflicts.length}`,
  )
  if (plan.conflicts.length) {
    const byKind = new Map<string, number>()
    for (const c of plan.conflicts) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1)
    console.log("  conflicts:", Object.fromEntries(byKind))
    // Distinct unresolved usernames (the people who'd lose group access).
    const names = new Map<string, number>()
    for (const c of plan.conflicts) {
      if (c.kind !== "unresolved-user") continue
      const m = c.detail.match(/^@(\S+)/)
      if (m) names.set(m[1], (names.get(m[1]) ?? 0) + 1)
    }
    const sorted = [...names.entries()].sort((a, b) => b[1] - a[1])
    console.log(`  distinct unresolved usernames (${sorted.length}):`)
    for (const [n, count] of sorted) console.log(`    @${n}  ×${count}`)
    for (const c of plan.conflicts.filter((c) => c.kind === "no-owner")) {
      console.log(`    [no-owner] ${c.detail}`)
    }
  }
}

function applyPlan(plan: GroupImportPlan, remote: boolean): void {
  // 1) Orgs — insert new (dedup on legacy_uuid), then resolve all referenced
  //    org uuids (new + existing) to autoincrement ids.
  if (plan.orgs.length) {
    const values = plan.orgs
      .map((o) => `(${s(o.name)}, ${o.ownerUserId}, ${s(o.legacyUuid)})`)
      .join(",\n")
    runSqlFile(
      `INSERT INTO organizations (name, owner_user_id, legacy_uuid) VALUES\n${values}\n` +
        `ON CONFLICT(legacy_uuid) DO NOTHING;`,
      remote,
    )
  }
  const orgUuids = [...new Set([...plan.orgs.map((o) => o.legacyUuid), ...plan.orgMembers.map((m) => m.orgUuid)])]
  const orgIdByUuid = idMap("organizations", orgUuids, remote)

  // 2) org_members.
  insertRows(
    "org_members",
    "(org_id, user_id, role_level, granted_by)",
    plan.orgMembers
      .filter((m) => orgIdByUuid.has(m.orgUuid))
      .map((m) => `(${orgIdByUuid.get(m.orgUuid)}, ${m.userId}, ${m.roleLevel}, NULL)`),
    remote,
  )

  // 3) Teams (groups).
  if (plan.teams.length) {
    const values = plan.teams
      .filter((t) => orgIdByUuid.has(t.orgUuid))
      .map((t) => `(${orgIdByUuid.get(t.orgUuid)}, ${s(t.name)}, ${t.createdBy}, ${s(t.legacyUuid)})`)
      .join(",\n")
    if (values) {
      runSqlFile(
        `INSERT INTO groups (org_id, name, created_by, legacy_uuid) VALUES\n${values}\n` +
          `ON CONFLICT(legacy_uuid) DO NOTHING;`,
        remote,
      )
    }
  }
  const teamUuids = [...new Set([...plan.teams.map((t) => t.legacyUuid), ...plan.teamMembers.map((m) => m.teamUuid)])]
  const teamIdByUuid = idMap("groups", teamUuids, remote)

  // 4) group_members.
  insertRows(
    "group_members",
    "(group_id, user_id, added_by)",
    plan.teamMembers
      .filter((m) => teamIdByUuid.has(m.teamUuid))
      .map((m) => `(${teamIdByUuid.get(m.teamUuid)}, ${m.userId}, NULL)`),
    remote,
  )
}

/** Resolve legacy_uuid → autoincrement id for rows present in `table`. */
function idMap(table: string, uuids: string[], remote: boolean): Map<string, number> {
  const map = new Map<string, number>()
  const CHUNK = 200
  for (let i = 0; i < uuids.length; i += CHUNK) {
    const inList = uuids.slice(i, i + CHUNK).map(s).join(",")
    if (!inList) continue
    for (const r of d1<{ legacy_uuid: string; id: number }>(
      `SELECT legacy_uuid, id FROM ${table} WHERE legacy_uuid IN (${inList})`,
      remote,
    )) {
      map.set(r.legacy_uuid, r.id)
    }
  }
  return map
}

function insertRows(table: string, cols: string, valueTuples: string[], remote: boolean): void {
  if (!valueTuples.length) return
  const CHUNK = 200
  const lines: string[] = []
  for (let i = 0; i < valueTuples.length; i += CHUNK) {
    lines.push(
      `INSERT OR IGNORE INTO ${table} ${cols} VALUES\n${valueTuples.slice(i, i + CHUNK).join(",\n")};`,
    )
  }
  runSqlFile(lines.join("\n"), remote)
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
