/**
 * AQU-2321 (AQU-346 regression): an org or team removal can end someone's
 * access to many projects at once, but only the project-member routes told
 * the sync-worker. This asks each project those grants could open, after the
 * delete, whether anything still admits the person, and where nothing does
 * sends the SAME member-removed notice the project route sends
 * (notifySyncWorkerOfMemberRemoval → ProjectSync DO eject + token denylist).
 * It is not a second revocation mechanism; it is the missing call to the first.
 *
 * Best-effort, like every caller of that notice: the hard guarantees are the
 * sync-token mint and the POST /events re-check, so a failure here never
 * fails the removal.
 */
import type { AuthUser, Env } from "../types"
import { forgetProjectRole, resolveProjectRole } from "./project-permissions"
import { notifySyncWorkerOfMemberRemoval } from "./sync-worker-notify"

/** Projects a team's membership opens: its attachments. */
export async function teamProjectIds(env: Env, groupId: number): Promise<string[]> {
  const { results } = await env.AQUILLA_PG.prepare("SELECT project_id FROM group_project_grants WHERE group_id = ?")
    .bind(groupId).all<{ project_id: string }>()
  return (results ?? []).map((r) => r.project_id)
}

/**
 * Projects an org membership opens for this person, read BEFORE the delete:
 * every live project when their org role clears the org-wide floor, and the
 * projects of every team in the org they sit on (the org route deletes those
 * memberships too).
 */
export async function orgReachProjectIds(env: Env, orgId: number, userId: number): Promise<string[]> {
  const [memberRow, teamRes] = await Promise.all([
    env.AQUILLA_PG.prepare("SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(orgId, userId).first<{ role_level: number }>(),
    env.AQUILLA_PG.prepare(
      `SELECT DISTINCT gpg.project_id FROM group_project_grants gpg
         JOIN group_members gm ON gm.group_id = gpg.group_id
         JOIN groups g ON g.id = gpg.group_id
        WHERE g.org_id = ? AND gm.user_id = ?`,
    ).bind(orgId, userId).all<{ project_id: string }>(),
  ])
  const ids = new Set((teamRes.results ?? []).map((r) => r.project_id))
  // Below the floor an org role opens a project only alongside a team (AQU-1274), covered above.
  if (Number(memberRow?.role_level ?? 0) >= 600) {
    const { results } = await env.AQUILLA_PG.prepare("SELECT id FROM projects WHERE org_id = ? AND archived_at IS NULL")
      .bind(orgId).all<{ id: string }>()
    for (const r of results ?? []) ids.add(r.id)
  }
  return [...ids]
}

/**
 * After the delete: find every candidate project the person no longer
 * resolves on (awaited, as the project route does), then send the notices
 * through `defer` (the route's waitUntil). Returns the projects they lost.
 */
export async function revokeLiveSessionsWhereLost(
  env: Env,
  userId: number,
  projectIds: readonly string[],
  defer: (work: Promise<unknown>) => void,
): Promise<string[]> {
  if (projectIds.length === 0) return []
  const user = await env.AQUILLA_PG.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<AuthUser>()
  if (!user) return []
  const lost: string[] = []
  for (const projectId of projectIds) {
    forgetProjectRole(env, projectId, userId)
    if (!(await resolveProjectRole(env, user, projectId))) lost.push(projectId)
  }
  if (lost.length > 0) {
    defer(Promise.all(lost.map((projectId) => notifySyncWorkerOfMemberRemoval(env, projectId, { userId, username: user.username }))))
  }
  return lost
}
