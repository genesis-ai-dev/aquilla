// AQU-2352 — the dry-run report for migration 0210, pure (no database, no
// clock unless `generatedAt` is left out). scripts/neon-org-roles.ts loads
// the tables read-only and prints it; scripts/org-roles-migration.test.ts
// checks it against the migration's real result.
import { diffAccess, renderAccessReportMarkdown, renderContext, roleLabel } from "./access-report"
import { AQU_2355_RULE, computeAccess, type RawAccessTables } from "./access-snapshot"
import {
  applyPlanToRaw,
  laneRoleDrops,
  laneRoles,
  liftGrantRecords,
  planOrgRoles,
  withoutFixRaw,
  type OrgRoleExtras,
  type OrgRolesPlan,
} from "./org-roles-plan"

export const MIGRATION_NAME = "0210_org_roles_member_maintainer_owner.sql"

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export interface OrgRolesReport {
  markdown: string
  json: unknown
  unintendedLosses: number
  laneRoleDropsAfter: number
  /** Rows 0210 writes to `org_role_lift_grants`: every lifted pair, archived included. */
  liftGrantsRecorded: number
}

/** Pure: build the report from the tables. Exported for the migration test. */
export function buildOrgRolesReport(
  raw: RawAccessTables,
  extras: OrgRoleExtras,
  opts: { mode: string; sourceNote?: string; snapshotDate?: string; generatedAt?: string } = { mode: "dry run" },
): OrgRolesReport & { plan: OrgRolesPlan } {
  const plan = planOrgRoles(raw, extras)
  const afterRaw = applyPlanToRaw(raw, plan)
  const noFixRaw = withoutFixRaw(raw, plan)
  const before = computeAccess(raw, AQU_2355_RULE)
  const after = computeAccess(afterRaw, AQU_2355_RULE)
  const noFix = computeAccess(noFixRaw, AQU_2355_RULE)
  const diff = diffAccess({ title: "Access before vs after migration 0210", before, after, grantsAdded: [] })
  const diffNoFix = diffAccess({ title: "without the fix", before, after: noFix, grantsAdded: [] })
  const laneBefore = laneRoles(raw)
  const dropsAfter = laneRoleDrops(laneBefore, laneRoles(afterRaw))
  const dropsNoFix = laneRoleDrops(laneBefore, laneRoles(noFixRaw))

  const ctx = renderContext(before, after)
  const orgName = new Map(raw.orgs.map((o) => [o.id, o.name?.trim() || `org ${o.id}`]))
  const userName = new Map(raw.users.map((u) => [u.id, u.username]))
  const projectName = new Map(raw.projects.map((p) => [p.id, p.name]))
  const laneName = new Map(raw.lanes.map((l) => [`${l.project_id}:${l.id}`, l.name]))
  const org = (id: number) => orgName.get(id) ?? `org ${id}`
  const who = (id: number) => userName.get(id) ?? `user ${id}`

  // Cross-check: AQU-2352 counted 363 rows at 200–500 on the dev copy (11-16).
  const snapshot = opts.snapshotDate ? new Date(`${opts.snapshotDate}T23:59:59Z`).getTime() : null
  const after11 = (c: { orgId: number; userId: number }) => {
    if (snapshot == null) return false
    const created = extras.orgCreatedAt.get(c.orgId)
    const granted = extras.orgMemberGrantedAt.get(`${c.orgId}:${c.userId}`)
    return (created != null && Date.parse(created) > snapshot) || (granted != null && Date.parse(granted) > snapshot)
  }
  const byLevel = (rows: OrgRolesPlan["orgRowChanges"]) => {
    const m: Record<number, number> = {}
    for (const r of rows) m[r.from] = (m[r.from] ?? 0) + 1
    return Object.entries(m).sort((a, b) => Number(b[0]) - Number(a[0])).map(([l, n]) => `${roleLabel(Number(l))} ${l}: ${n}`).join(", ")
  }
  const old = plan.orgRowChanges.filter((c) => !after11(c))
  const recent = plan.orgRowChanges.filter((c) => after11(c))

  const records = liftGrantRecords(plan)
  const liveLifted = plan.lifted.filter((p) => !p.projectArchived)
  const liftPeople = new Set(liveLifted.map((p) => p.userId))
  const fixedLanes = liveLifted.flatMap((p) => p.lanes.filter((l) => !l.archived))

  const out: string[] = []
  out.push("# AQU-2352 dry run: organization roles are Member, Maintainer and Owner", "")
  out.push(
    `Mode: **${opts.mode}**. Generated ${opts.generatedAt ?? new Date().toISOString()}.` + (opts.sourceNote ? ` Data: ${opts.sourceNote}` : ""),
    "",
  )
  out.push("## Headline", "")
  out.push(`- **Unintended losses after migration ${MIGRATION_NAME}: ${diff.totals.unintendedLosses}** (person–project pairs that lose a lane or role). Lane roles that drop: **${dropsAfter.length}**. Gains: ${diff.totals.gains}.`)
  out.push(`- **Org rows that become Member: ${plan.orgRowChanges.length}** (${byLevel(plan.orgRowChanges) || "none"}).`)
  out.push(
    `- **The AQU-1274 lift raises ${liftPeople.size} people on ${liveLifted.length} live person–project pairs** (${plan.lifted.length - liveLifted.length} more on archived projects). ` +
      `Without the fix, ${diffNoFix.totals.unintendedLosses} pairs would drop a project role and ${dropsNoFix.length} lane roles would drop. ` +
      `The migration gives each of them a direct project grant at their org level and raises ${fixedLanes.filter((l) => l.grantAfter !== l.grantBefore).length} lane grant(s) to it.`,
  )
  out.push(
    `- **The migration records ${records.length} lifted pair(s) in \`org_role_lift_grants\`** (archived included): the project, the person, the org level, their teams on the project, ` +
      `whether it created the project grant, and the lane rows it raised (${records.reduce((n, r) => n + r.laneIds.length, 0)}). ` +
      "These grants are temporary: AQU-2354 moves this access onto their teams and deletes exactly the recorded grants.",
  )
  out.push(
    `- **Loses the org Members page: ${plan.membersPageLosses.length}** — ${plan.membersPageLosses.map((l) => `${who(l.userId)} (${org(l.orgId)}, ${roleLabel(l.orgLevel)} vs floor ${roleLabel(l.floor)})`).join(", ") || "nobody"}. Intended (AQU-2352).`,
  )
  out.push(`- **Pending org invites that become Member: ${plan.inviteChanges.length}**.`)
  if (plan.belowMember.length > 0) out.push(`- Org rows below Member (left alone): ${plan.belowMember.length}.`)
  out.push("")

  out.push("## Cross-check against AQU-2352 (dev copy, 11-16)", "")
  out.push("AQU-2352 counted **363 rows at 200–500** (354 at 400, 8 at 500, 1 at 300) and the lift on **4 people, 10 person–project pairs** (Biblica Global Publishing 1 on 5, Biblica ETT 2 on 3 projects, testGroup 1 on 1).", "")
  out.push(`- All rows here: ${plan.orgRowChanges.length} (${byLevel(plan.orgRowChanges)}).`)
  if (snapshot != null) {
    out.push(`- Rows whose org was created, or whose org row was granted, after ${opts.snapshotDate}: ${recent.length} (${byLevel(recent) || "none"}). Without them: ${old.length} (${byLevel(old)}).`)
    const recentOrgs = new Map<string, number>()
    for (const r of recent) recentOrgs.set(org(r.orgId), (recentOrgs.get(org(r.orgId)) ?? 0) + 1)
    if (recentOrgs.size > 0) out.push(`  - By org: ${[...recentOrgs].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ")}.`)
    const recentLift = liveLifted.filter((p) => after11({ orgId: p.orgId, userId: p.userId }))
    out.push(`- Lift pairs whose org row was granted after ${opts.snapshotDate}: ${recentLift.length}${recentLift.length ? ` (${[...new Set(recentLift.map((p) => `${who(p.userId)}, ${org(p.orgId)}`))].join("; ")})` : ""}. Without them: ${liveLifted.length - recentLift.length} pairs, ${new Set(liveLifted.filter((p) => !recentLift.includes(p)).map((p) => p.userId)).size} people.`)
  }
  out.push("")

  out.push("## Who the lift raises, and the grant that fixes it", "")
  out.push("Role on a lane = the higher of the project role and the lane grant (the write wall's `effectiveRoleInLane`); Maintainer and above reach every lane. \"Without the fix\" = the lift removed and nothing compensated.", "")
  out.push(
    "Why a direct project grant and not only lane grants: most checks still read the PROJECT role until AQU-2353 (assignment, roster, progress, comments, the sync token's `role`), " +
      "and a team-only member's lane rows are rebuilt from their teams at most Contributor by the next team change (`reconcileMemberProjectLanes`, auth-worker services/lane-grants.ts), " +
      "so a Project Lead lane grant on a team-only path would not survive one. With a direct project row the person is a direct member: their lane rows are direct (`team_group_id` NULL) and a team change leaves them alone.",
    "",
  )
  out.push("| Org | Person | Project | Org role | Team role | Project role today → without fix → after | Lane | Lane role today → without fix → after | Grant written |")
  out.push("|---|---|---|---|---|---|---|---|---|")
  for (const p of plan.lifted) {
    const proj = cell((projectName.get(p.projectId) ?? p.projectId) + (p.projectArchived ? " (archived)" : ""))
    const head = `| ${cell(org(p.orgId))} | ${cell(who(p.userId))} | ${proj} | ${roleLabel(p.orgLevel)} | ${roleLabel(p.teamLevel)} | ${roleLabel(p.roleBefore)} → ${roleLabel(p.roleWithoutFix)} → ${roleLabel(p.orgLevel)} (direct)`
    if (p.lanes.length === 0) {
      out.push(`${head} | — (reads no lane) | — | direct project grant ${roleLabel(p.orgLevel)} |`)
      continue
    }
    for (const l of p.lanes) {
      const after = Math.max(p.orgLevel, l.grantAfter)
      const grant = [
        `direct project grant ${roleLabel(p.orgLevel)}`,
        l.grantAfter !== l.grantBefore ? `lane grant ${roleLabel(l.grantBefore)} → ${roleLabel(l.grantAfter)}` : `lane grant stays ${roleLabel(l.grantAfter)}`,
        ...(l.becomesDirect ? ["lane grant becomes direct"] : []),
      ].join("; ")
      out.push(`${head} | ${cell((laneName.get(`${p.projectId}:${l.laneId}`) ?? l.laneId) + (l.archived ? " (archived)" : ""))} | ${roleLabel(l.laneRoleBefore)} → ${roleLabel(l.laneRoleWithoutFix)} → ${roleLabel(after)} | ${grant} |`)
    }
  }
  out.push("")

  out.push("## Who loses the org Members page", "")
  out.push("`GET /orgs/:orgId/members` checks the ORG role against the org's roster floor (`rosterViewMinRole`, default Maintainer). They still see the people on their own projects.", "")
  if (plan.membersPageLosses.length === 0) out.push("Nobody.", "")
  else {
    out.push("| Org | Person | Org role today | Floor |", "|---|---|---|---|")
    for (const l of plan.membersPageLosses) out.push(`| ${cell(org(l.orgId))} | ${cell(who(l.userId))} | ${roleLabel(l.orgLevel)} | ${roleLabel(l.floor)} |`)
    out.push("")
  }

  out.push("## Pending org invites that become Member", "")
  if (plan.inviteChanges.length === 0) out.push("None.", "")
  else {
    out.push("| Org | Role today | Sent to | Expired |", "|---|---|---|---|")
    for (const i of plan.inviteChanges) out.push(`| ${cell(org(i.orgId))} | ${roleLabel(i.from)} | ${i.email ? "an email address" : "open link"} | ${i.expired ? "yes" : "no"} |`)
    out.push("")
  }

  out.push("## Org rows that become Member, by organization", "")
  const rowsByOrg = new Map<number, OrgRolesPlan["orgRowChanges"]>()
  for (const r of plan.orgRowChanges) rowsByOrg.set(r.orgId, [...(rowsByOrg.get(r.orgId) ?? []), r])
  out.push("| Organization | Rows | By role |", "|---|---|---|")
  for (const [orgId, rows] of [...rowsByOrg].sort((a, b) => b[1].length - a[1].length || org(a[0]).localeCompare(org(b[0])))) {
    out.push(`| ${cell(org(orgId))} | ${rows.length} | ${byLevel(rows)} |`)
  }
  out.push("")
  for (const [orgId, rows] of [...rowsByOrg].sort((a, b) => org(a[0]).localeCompare(org(b[0])))) {
    out.push(`### ${cell(org(orgId))} (${rows.length})`, "")
    out.push(rows.map((r) => `${cell(who(r.userId))} (${roleLabel(r.from)})`).join(", "), "")
  }

  const accessMd = renderAccessReportMarkdown(diff, ctx, {})
  out.push("## Access diff before vs after (AQU-2355 report)", "")
  out.push(accessMd.replace(/^# .*\n/, "").replace(/^## /gm, "### "))

  const markdown = out.join("\n")
  return {
    plan,
    markdown,
    json: { plan, totals: diff.totals, laneRoleDropsAfter: dropsAfter, laneRoleDropsWithoutFix: dropsNoFix, liftGrantRecords: records },
    unintendedLosses: diff.totals.unintendedLosses,
    laneRoleDropsAfter: dropsAfter.length,
    liftGrantsRecorded: records.length,
  }
}

