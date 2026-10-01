/**
 * AQU-1352 §3.7 rules 1–5: per-row origin data for the project roster.
 *
 * Additive fields on GET /api/v2/projects/:projectId/members, computed with
 * the same pure resolver the access_grants view feeds (resolveFromGrants), so
 * a roster row, the inspector and enforcement explain one answer:
 *   - effective          winner of max-wins (level + source)
 *   - direct             the direct project grant, if any
 *   - inheritedFrom      scope path of the winning team/org grant
 *   - afterDirectRemoval dry-run for rule 4: what survives if the direct
 *                        grant is removed (null = access ends)
 */

import type { Env } from "../types"
import {
  resolveFromGrants,
  type AccessGrant,
  type ChainLink,
  type GrantScope,
  type GrantSource,
  type ResolvedSource,
} from "../../../db/shared/access-grants"
import type { ScopePath } from "./access-payload"

export interface RosterGrantOrigin {
  roleLevel: number
  source: ResolvedSource
  from: ScopePath | null
}

export interface RosterOrigin {
  effective: { roleLevel: number; source: ResolvedSource }
  direct: number | null
  inheritedFrom: ScopePath | null
  afterDirectRemoval: RosterGrantOrigin | null
}

export interface RosterContext {
  projectId: string
  orgId: string | null
  orgName: string | null
  attachedTeamIds: readonly string[]
  teamNames: ReadonlyMap<string, string>
}

function pathFor(link: ChainLink, ctx: RosterContext): ScopePath | null {
  const org = ctx.orgId ? [{ type: "org" as const, id: ctx.orgId, name: ctx.orgName ?? "" }] : []
  if (link.source === "org") return org
  if (link.source === "group" && link.grant?.viaTeamId) {
    const id = link.grant.viaTeamId
    return [...org, { type: "team", id, name: ctx.teamNames.get(id) ?? "" }]
  }
  return null
}

/** Pure: one user's grants → roster origin. Null when the user has no access. */
export function rosterOriginFor(
  grants: readonly AccessGrant[],
  ctx: RosterContext,
): RosterOrigin | null {
  const base = {
    projectId: ctx.projectId,
    orgId: ctx.orgId,
    archivedAt: null,
    includeArchived: true,
    isPlatformAdmin: false,
    attachedTeamIds: ctx.attachedTeamIds,
  }
  const resolved = resolveFromGrants(grants, base)
  if (!resolved) return null
  const winner = resolved.chain[0]
  const direct = resolved.chain.find((l) => l.source === "override")
  let afterDirectRemoval: RosterGrantOrigin | null = null
  if (direct) {
    // Rule 4 dry-run: re-resolve without the direct row. The org path can
    // change here (AQU-1274: a sub-floor org role only counts beside a team
    // grant once there is no direct grant), so re-run rather than slice.
    const without = grants.filter(
      (g) => !(g.scopeType === "project" && g.scopeId === ctx.projectId && g.source === "direct"),
    )
    const after = resolveFromGrants(without, base)
    if (after) {
      afterDirectRemoval = {
        roleLevel: after.level,
        source: after.source,
        from: pathFor(after.chain[0], ctx),
      }
    }
  }
  return {
    effective: { roleLevel: resolved.level, source: resolved.source },
    direct: direct?.level ?? null,
    inheritedFrom: pathFor(winner, ctx),
    afterDirectRemoval,
  }
}

interface GrantRow {
  user_id: number | string
  scope_type: GrantScope
  scope_id: string
  role_level: number | string
  source: GrantSource
  via_team_id: number | string | null
}

/** Load every grant relevant to one project and compute each user's origin. */
export async function loadRosterOrigins(
  env: Env,
  projectId: string,
  orgId: number | null,
): Promise<Map<number, RosterOrigin>> {
  const db = env.AQUILLA_PG
  const orgIdStr = orgId == null ? null : String(orgId)
  const teams = await db
    .prepare(
      `SELECT DISTINCT g.id AS id, g.name AS name
         FROM group_project_grants gpg JOIN groups g ON g.id = gpg.group_id
        WHERE gpg.project_id = ?`,
    )
    .bind(projectId)
    .all<{ id: number | string; name: string }>()
  const teamNames = new Map((teams.results ?? []).map((t) => [String(t.id), t.name]))
  const org = orgIdStr
    ? await db
        .prepare(`SELECT name FROM organizations WHERE id = ?`)
        .bind(orgIdStr)
        .first<{ name: string | null }>()
    : null

  const { results } = await db
    .prepare(
      `SELECT user_id, scope_type, scope_id, role_level, source, via_team_id
         FROM access_grants
        WHERE (scope_type = 'project' AND scope_id = ?)
           OR (scope_type = 'org' AND scope_id = ?)
           OR (scope_type = 'team' AND scope_id IN (
                 SELECT group_id::TEXT FROM group_project_grants WHERE project_id = ?))`,
    )
    .bind(projectId, orgIdStr ?? "", projectId)
    .all<GrantRow>()

  const byUser = new Map<string, AccessGrant[]>()
  for (const r of results ?? []) {
    const userId = String(r.user_id)
    const list = byUser.get(userId) ?? []
    list.push({
      userId,
      scopeType: r.scope_type,
      scopeId: String(r.scope_id),
      roleLevel: Number(r.role_level),
      source: r.source,
      viaTeamId: r.via_team_id == null ? null : String(r.via_team_id),
      grantedBy: null,
      grantedAt: null,
    })
    byUser.set(userId, list)
  }

  const ctx: RosterContext = {
    projectId,
    orgId: orgIdStr,
    orgName: org?.name ?? null,
    attachedTeamIds: [...teamNames.keys()],
    teamNames,
  }
  const out = new Map<number, RosterOrigin>()
  for (const [userId, grants] of byUser) {
    const origin = rosterOriginFor(grants, ctx)
    if (origin) out.set(Number(userId), origin)
  }
  return out
}
