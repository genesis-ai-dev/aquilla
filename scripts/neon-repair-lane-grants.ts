#!/usr/bin/env tsx
// AQU-1786 — repair missing lane grants. Dry-run by default.
//
// Inserts a project_member_lane_roles row for each current, non-archived
// target lane that an unscoped member below Maintainer does not already hold,
// at that member's project role. Members with any kind='lane' scope are not
// touched. Existing grant rows are not updated or deleted. A second apply
// inserts nothing.
//
//   pnpm neon:repair-lane-grants:dev
//   pnpm neon:repair-lane-grants:dev -- --out /tmp/grant-repair-dev.json
//   pnpm neon:repair-lane-grants:prod -- --out /tmp/grant-repair-prod.json
//   pnpm neon:repair-lane-grants:prod -- --apply --project <id>
//
// Do not pass --apply until a person has read the dry-run report. This script
// never deletes.
//
// Flags: --apply  --project <id>  --limit <n>  --out <file>
import { writeFileSync } from "node:fs"
import { resolveProjectRoleIncludingArchivedShared } from "../db/shared/project-roles"
import { makePostgres, type AquillaDb } from "../db/shim/postgres"
import { planGrantRepair, type GrantRepairInsert, type GrantRepairLane, type GrantRepairMember } from "../src/lib/lanes/grant-repair"

interface ReportInsert extends GrantRepairInsert {
  projectId: string
  username: string | null
}

interface ProjectSummary {
  projectId: string
  membersAffected: number
  inserts: number
}

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || "neondb"
  const role = process.env.NEON_PG_ROLE?.trim() || "neondb_owner"
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error("NEON_PG_HOST and NEON_PG_PASSWORD are required")
  const url = new URL("postgresql://placeholder")
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set("sslmode", "require")
  return url.toString()
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function archivedFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true"
}

const LANES = `SELECT id, name, archived_at IS NOT NULL AS archived
  FROM lanes
  WHERE project_id = ? AND role = 'target'
  ORDER BY position, id`

const CANDIDATES = `SELECT DISTINCT u.user_id, usr.email, usr.username
  FROM (
    SELECT user_id FROM project_members WHERE project_id = ?
    UNION
    SELECT gm.user_id
      FROM group_project_grants gpg
      JOIN group_members gm ON gm.group_id = gpg.group_id
     WHERE gpg.project_id = ?
    UNION
    SELECT created_by AS user_id FROM projects WHERE id = ?
  ) u
  LEFT JOIN users usr ON usr.id = u.user_id`

const SCOPES = `SELECT user_id, value
  FROM project_member_scopes
  WHERE project_id = ? AND kind = 'lane'`

const GRANTS = `SELECT user_id, lane
  FROM project_member_lane_roles
  WHERE project_id = ?`

const INSERT_GRANT = `INSERT INTO project_member_lane_roles
    (project_id, user_id, lane, role_level)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (project_id, user_id, lane) DO NOTHING`

async function repairProject(
  db: AquillaDb,
  projectId: string,
  apply: boolean,
  adminEmails: string | undefined,
): Promise<{ inserts: ReportInsert[]; summary: ProjectSummary }> {
  const { results: laneRows } = await db
    .prepare(LANES)
    .bind(projectId)
    .all<{ id: string; name: string; archived: unknown }>()
  const lanes: GrantRepairLane[] = laneRows.map((row) => ({
    id: row.id,
    name: row.name,
    archived: archivedFlag(row.archived),
  }))

  const { results: candidates } = await db
    .prepare(CANDIDATES)
    .bind(projectId, projectId, projectId)
    .all<{ user_id: string | number; email: string | null; username: string | null }>()
  const { results: scopeRows } = await db
    .prepare(SCOPES)
    .bind(projectId)
    .all<{ user_id: string | number; value: string }>()
  const { results: grantRows } = await db
    .prepare(GRANTS)
    .bind(projectId)
    .all<{ user_id: string | number; lane: string }>()

  const scopesByUser = new Map<string, string[]>()
  for (const row of scopeRows) {
    const id = String(row.user_id)
    const list = scopesByUser.get(id) ?? []
    list.push(row.value)
    scopesByUser.set(id, list)
  }
  const grantsByUser = new Map<string, string[]>()
  for (const row of grantRows) {
    const id = String(row.user_id)
    const list = grantsByUser.get(id) ?? []
    list.push(row.lane)
    grantsByUser.set(id, list)
  }
  const names = new Map(candidates.map((row) => [String(row.user_id), row.username]))

  const members: GrantRepairMember[] = []
  for (const candidate of candidates) {
    const userId = String(candidate.user_id)
    const resolution = await resolveProjectRoleIncludingArchivedShared(
      db,
      { id: userId, email: candidate.email },
      projectId,
      adminEmails,
    )
    if (!resolution) continue
    members.push({
      userId,
      roleLevel: resolution.level,
      platform: resolution.source === "platform",
      laneScopes: scopesByUser.get(userId) ?? [],
      grantLaneIds: grantsByUser.get(userId) ?? [],
    })
  }

  const plan = planGrantRepair({ members, lanes })
  const inserts: ReportInsert[] = plan.inserts.map((row) => ({
    ...row,
    projectId,
    username: names.get(row.userId) ?? null,
  }))

  if (apply) {
    for (const row of inserts) {
      await db.prepare(INSERT_GRANT).bind(projectId, row.userId, row.laneId, row.level).run()
    }
  }

  const membersAffected = new Set(inserts.map((row) => row.userId)).size
  return {
    inserts,
    summary: { projectId, membersAffected, inserts: inserts.length },
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const onlyProject = flagValue("--project")
  const outPath = flagValue("--out")
  const limitRaw = flagValue("--limit")
  const limit = limitRaw === undefined ? undefined : Number(limitRaw)
  if (limitRaw !== undefined && (!Number.isInteger(limit) || (limit ?? 0) < 1)) {
    throw new Error("--limit must be a positive integer")
  }

  const db = makePostgres(connectionString(), 1)
  try {
    await db.exec(`SET statement_timeout = '120s'`)
    await db.exec(`SET lock_timeout = '3s'`)

    let sql = `SELECT id FROM projects`
    const binds: unknown[] = []
    if (onlyProject) {
      sql += ` WHERE id = ?`
      binds.push(onlyProject)
    }
    sql += ` ORDER BY id`
    if (limit !== undefined) sql += ` LIMIT ${limit}`

    const { results: projects } = await db.prepare(sql).bind(...binds).all<{ id: string }>()
    const inserts: ReportInsert[] = []
    const projectsAffected: ProjectSummary[] = []
    const adminEmails = process.env.ADMIN_EMAILS
    for (const project of projects) {
      const repaired = await repairProject(db, project.id, apply, adminEmails)
      if (repaired.inserts.length === 0) continue
      inserts.push(...repaired.inserts)
      projectsAffected.push(repaired.summary)
    }

    const report = {
      mode: apply ? "apply" : "dry-run",
      deletions: [] as const,
      scopedMemberChanges: [] as const,
      insertCount: inserts.length,
      projectsAffected,
      inserts,
    }
    console.log(
      `${apply ? "APPLY" : "DRY RUN"}: ${inserts.length} grant(s) on ${projectsAffected.length} project(s). ` +
        `deletions=0 scopedMemberChanges=0`,
    )
    for (const project of projectsAffected) {
      console.log(`  ${project.projectId}: ${project.membersAffected} member(s), ${project.inserts} grant(s)`)
    }
    if (outPath) {
      writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n")
      console.log(`wrote ${outPath}`)
    } else if (inserts.length > 0) {
      console.log("pass --out <file> for the full (project, member, lane) list")
    }
  } finally {
    await db.close?.()
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
})
