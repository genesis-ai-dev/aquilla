// AQU-625: username prefix search lists people. It is allowed only for a caller
// who can already see a member roster — the same gate as the member list, not
// a second, looser one. Platform admins are decided by the route before this
// runs; this answers for an ordinary account.

import type { Env } from "../types"
import { getProjectRosterListFloors } from "./org-permissions"
import {
  loadProjectVisibilityOverride,
  orgVisibilityFloor,
} from "../../../db/shared/visibility-floors"

interface OrgMembership {
  org_id: number | string
  role_level: number | string
  settings: string | null
}

interface ProjectGrant {
  project_id: string
  org_id: number | string | null
  role_level: number | string
}

function asNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value)
}

function settingsObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // A malformed blob does not lower the floor.
  }
  return {}
}

/**
 * True when this caller may run username search.
 *
 * An org member at or above that org's `rosterViewMinRole` can see the org
 * roster. Anyone else can search only when a project they can actually open
 * (direct grant, team grant, or creator) meets that project's member-list
 * floor — the floor `GET /projects/:id/members` uses, assignment carve-out
 * included. A sub-maintainer org role does not open projects by itself, so it
 * does not open search either.
 */
export async function callerCanSearchUsers(env: Env, userId: number): Promise<boolean> {
  const [orgs, grants] = await Promise.all([
    env.AQUILLA_PG.prepare(
      `SELECT om.org_id, om.role_level, os.settings
         FROM org_members om
         LEFT JOIN org_settings os ON os.org_id = om.org_id
        WHERE om.user_id = ?`,
    )
      .bind(userId)
      .all<OrgMembership>(),
    env.AQUILLA_PG.prepare(
      `SELECT project_id, org_id, MAX(role_level) AS role_level
         FROM (
           SELECT pm.project_id AS project_id, p.org_id AS org_id, pm.role_level AS role_level
             FROM project_members pm
             JOIN projects p ON p.id = pm.project_id
            WHERE pm.user_id = ? AND p.archived_at IS NULL
           UNION ALL
           SELECT gpg.project_id, p.org_id, gpg.role_level
             FROM group_members gm
             JOIN group_project_grants gpg ON gpg.group_id = gm.group_id
             JOIN projects p ON p.id = gpg.project_id
            WHERE gm.user_id = ? AND p.archived_at IS NULL
           UNION ALL
           SELECT p.id, p.org_id, 700
             FROM projects p
            WHERE p.created_by = ? AND p.archived_at IS NULL
         ) grants
        GROUP BY project_id, org_id`,
    )
      .bind(userId, userId, userId)
      .all<ProjectGrant>(),
  ])

  for (const org of orgs.results ?? []) {
    const role = asNumber(org.role_level)
    const floor = orgVisibilityFloor(settingsObject(org.settings), "rosterViewMinRole")
    if (role >= floor) return true
  }

  const byOrg = new Map<number | null, Array<{ projectId: string; role: number }>>()
  for (const grant of grants.results ?? []) {
    const orgId = grant.org_id == null ? null : asNumber(grant.org_id)
    const row = { projectId: grant.project_id, role: asNumber(grant.role_level) }
    const list = byOrg.get(orgId)
    if (list) list.push(row)
    else byOrg.set(orgId, [row])
  }

  for (const [orgId, rows] of byOrg) {
    if (orgId == null) {
      for (const row of rows) {
        const own = await loadProjectVisibilityOverride(env.AQUILLA_PG, row.projectId)
        // Null is an ungated personal-project roster: any member may see it.
        if (own.rosterViewMinRole == null || row.role >= own.rosterViewMinRole) return true
      }
      continue
    }
    const floors = await getProjectRosterListFloors(
      env,
      orgId,
      rows.map((row) => row.projectId),
    )
    for (const row of rows) {
      const floor = floors.get(row.projectId)
      if (floor == null || row.role >= floor) return true
    }
  }

  return false
}
