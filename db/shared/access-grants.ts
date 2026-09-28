// AQU-1352 P1 (spec §3, §5): one read shape for every grant, one pure resolver.
//
// `access_grants` (migration 0130) is a UNION ALL view over org_members,
// project_members, group_members x group_project_grants and projects.created_by.
// resolveFromGrants reproduces db/shared/project-roles.ts
// resolveProjectRoleShared EXACTLY (AD-12 max-wins, AQU-435 floor, AQU-1274
// org-path rule, creator, platform admin). It also returns the `chain` of
// contributing grants for the future member inspector.
//
// Callers reach resolveProjectRoleViaGrants through ACCESS_GRANTS_RESOLVER
// (shadow/on); the per-table resolver queries go when `on` is the default.

import type { AquillaDb } from "../shim/postgres"
import { orgPathContribution } from "./project-roles"

export type GrantSource = "direct" | "team" | "creator"
export type GrantScope = "org" | "project" | "team"

/** One row of the access_grants view. Ids are strings (BIGINT over the shim). */
export interface AccessGrant {
  userId: string
  scopeType: GrantScope
  scopeId: string
  roleLevel: number
  source: GrantSource
  viaTeamId: string | null
  grantedBy: string | null
  grantedAt: string | null
}

/** Attribution names, identical to resolveProjectRoleShared's `source`. */
export type ResolvedSource = "override" | "group" | "org" | "creator" | "platform"

export interface ChainLink {
  source: ResolvedSource
  level: number
  /** Null for the platform-admin path: it is env-driven, not a view row. */
  grant: AccessGrant | null
}

export interface ResolvedRole {
  level: number
  source: ResolvedSource
  /** Every contributing path, winner first (same order as max-wins). */
  chain: ChainLink[]
}

export interface ResolveContext {
  projectId: string
  orgId: string | null
  archivedAt: string | null
  includeArchived?: boolean
  isPlatformAdmin: boolean
  /**
   * AQU-1352 P2: teams attached to this project (group_project_grants). A
   * team-scope grant (scopeType 'team') contributes only when its team is here.
   */
  attachedTeamIds?: readonly string[]
}

// Declaration order override > group > org > creator > platform wins ties.
const SOURCE_PRIORITY: Record<ResolvedSource, number> = {
  override: 4,
  group: 3,
  org: 2,
  creator: 1,
  platform: 0,
}

/**
 * Pure max-wins over the user's grants. `grants` must be the user's own rows;
 * rows for other projects/orgs are ignored.
 */
export function resolveFromGrants(
  grants: readonly AccessGrant[],
  ctx: ResolveContext,
): ResolvedRole | null {
  if (ctx.archivedAt && !ctx.includeArchived) return null

  const onProject = grants.filter(
    (g) => g.scopeType === "project" && g.scopeId === ctx.projectId,
  )
  const direct = onProject.find((g) => g.source === "direct") ?? null
  // AQU-1352 P2 (spec §3.1): a team-scope role flows to every attached project
  // and joins max-wins exactly like a per-project team path. viaTeamId carries
  // the team so the chain names it.
  const attached = new Set(ctx.attachedTeamIds ?? [])
  const teamScope = grants
    .filter((g) => g.scopeType === "team" && attached.has(g.scopeId))
    .map((g): AccessGrant => ({ ...g, viaTeamId: g.scopeId }))
  const teamPaths = [...onProject.filter((g) => g.source === "team"), ...teamScope]
  const bestTeam = teamPaths
    .reduce<AccessGrant | null>(
      (best, g) => (best == null || g.roleLevel > best.roleLevel ? g : best),
      null,
    )
  const creator = onProject.find((g) => g.source === "creator") ?? null
  const org =
    ctx.orgId == null
      ? null
      : (grants.find((g) => g.scopeType === "org" && g.scopeId === ctx.orgId) ?? null)

  const chain: ChainLink[] = []
  if (direct) chain.push({ source: "override", level: direct.roleLevel, grant: direct })
  // Every contributing team path is listed (member inspector); the stable sort
  // below keeps bestTeam ahead of equal-level siblings, so level/source are unchanged.
  if (bestTeam) chain.push({ source: "group", level: bestTeam.roleLevel, grant: bestTeam })
  for (const t of teamPaths) {
    if (t !== bestTeam) chain.push({ source: "group", level: t.roleLevel, grant: t })
  }
  const orgLevel = orgPathContribution({
    orgLevel: org?.roleLevel ?? null,
    hasDirectGrant: direct != null,
    hasGroupGrant: bestTeam != null,
  })
  if (orgLevel != null && org) chain.push({ source: "org", level: orgLevel, grant: org })
  if (creator) chain.push({ source: "creator", level: 700, grant: creator })
  if (ctx.isPlatformAdmin) chain.push({ source: "platform", level: 700, grant: null })

  if (chain.length === 0) return null
  chain.sort((a, b) =>
    a.level !== b.level ? b.level - a.level : SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source],
  )
  return { level: chain[0].level, source: chain[0].source, chain }
}

interface GrantRow {
  user_id: number | string
  scope_type: GrantScope
  scope_id: string
  role_level: number
  source: GrantSource
  via_team_id: number | string | null
  granted_by: number | string | null
  granted_at: string | Date | null
}

// Same parsing as project-roles.ts parseAdminEmails (not exported there).
function adminEmailSet(adminEmails: string | undefined): Set<string> {
  return new Set(
    (adminEmails ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  )
}

const toId = (v: number | string | null): string | null => (v == null ? null : String(v))

export interface ProjectGrants {
  grants: AccessGrant[]
  attachedTeamIds: string[]
  orgId: string | null
  archivedAt: string | null
}

/** Load the user's grants relevant to one project. Null when the project is missing. */
export async function loadProjectGrants(
  db: AquillaDb,
  userId: string,
  projectId: string,
): Promise<ProjectGrants | null> {
  const project = await db
    .prepare(`SELECT org_id, archived_at FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | string | null; archived_at: string | Date | null }>()
  if (!project) return null
  const orgId = toId(project.org_id)

  const attachedRows = await db
    .prepare(`SELECT DISTINCT group_id FROM group_project_grants WHERE project_id = ?`)
    .bind(projectId)
    .all<{ group_id: number | string }>()
  const attachedTeamIds = (attachedRows.results ?? []).map((r) => String(r.group_id))

  const { results } = await db
    .prepare(
      `SELECT user_id, scope_type, scope_id, role_level, source,
              via_team_id, granted_by, granted_at
         FROM access_grants
        WHERE user_id = ?
          AND ((scope_type = 'project' AND scope_id = ?)
               OR (scope_type = 'org' AND scope_id = ?)
               OR (scope_type = 'team' AND scope_id IN (
                     SELECT group_id::TEXT FROM group_project_grants WHERE project_id = ?)))`,
    )
    .bind(userId, projectId, orgId ?? "", projectId)
    .all<GrantRow>()

  const grants = (results ?? []).map((r): AccessGrant => ({
    userId: String(r.user_id),
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    roleLevel: Number(r.role_level),
    source: r.source,
    viaTeamId: toId(r.via_team_id),
    grantedBy: toId(r.granted_by),
    grantedAt: r.granted_at == null ? null : String(r.granted_at),
  }))
  return {
    grants,
    attachedTeamIds,
    orgId,
    archivedAt: project.archived_at == null ? null : String(project.archived_at),
  }
}

/**
 * View-backed twin of resolveProjectRoleShared. Not wired to any caller yet.
 * SWARM-TODO(AQU-1352): unlike the original, a missing view throws instead of
 * degrading one path to "no contribution" (safeFirst). Decide at switch-over.
 */
export async function resolveProjectRoleViaGrants(
  db: AquillaDb,
  user: { id: string; email?: string | null },
  projectId: string,
  adminEmails?: string,
  includeArchived = false,
): Promise<ResolvedRole | null> {
  const loaded = await loadProjectGrants(db, user.id, projectId)
  if (!loaded) return null
  const email = user.email?.trim().toLowerCase()
  return resolveFromGrants(loaded.grants, {
    projectId,
    orgId: loaded.orgId,
    archivedAt: loaded.archivedAt,
    includeArchived,
    attachedTeamIds: loaded.attachedTeamIds,
    isPlatformAdmin: !!email && adminEmailSet(adminEmails).has(email),
  })
}
