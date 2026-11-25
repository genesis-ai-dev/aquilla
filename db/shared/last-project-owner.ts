// AQU-2357: a project keeps at least one direct Owner — a project_members row
// at 700. An org Owner, a team grant, and a platform admin do not count.
// Every org already has an org Owner, so counting that path left org projects
// with no Owner of their own.

import type { AquillaDb } from "../shim/postgres"

export const LAST_PROJECT_OWNER_MESSAGE =
  "This project needs at least one owner. Grant someone else the Owner role before removing this one."

/**
 * True when dropping this person's direct Owner grant would leave the project
 * with no direct Owner. Call only when the action removes or demotes a direct
 * row that is currently >= 700.
 */
export async function removingDirectOwnerLeavesNone(
  db: Pick<AquillaDb, "prepare">,
  projectId: string,
  targetUserId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok
         WHERE EXISTS (
           SELECT 1 FROM project_members
            WHERE project_id = ? AND user_id <> ? AND role_level >= 700
         )`,
    )
    .bind(projectId, targetUserId)
    .first<{ ok: number }>()
  return row == null
}

/**
 * Projects in this org where this person is a direct Owner and nobody else is.
 * Removing their project grants would leave those projects with no Owner.
 */
export async function soleDirectOwnerProjectsInOrg(
  db: Pick<AquillaDb, "prepare">,
  orgId: number,
  targetUserId: number,
): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .prepare(
      `SELECT p.id AS id, p.name AS name
         FROM projects p
         JOIN project_members pm
           ON pm.project_id = p.id AND pm.user_id = ? AND pm.role_level >= 700
        WHERE p.org_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM project_members other
             WHERE other.project_id = p.id
               AND other.user_id <> ?
               AND other.role_level >= 700
          )
        ORDER BY LOWER(p.name), p.id`,
    )
    .bind(targetUserId, orgId, targetUserId)
    .all<{ id: string; name: string }>()
  return rows.results ?? []
}
