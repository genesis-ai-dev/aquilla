// AQU-2357: a project keeps at least one Owner. An Owner is a direct
// project_members row at 700, or an org member at 700 on the project's org.
// Team grants and platform admins are not Owners for this guard.

import type { AquillaDb } from "../shim/postgres"

export const LAST_PROJECT_OWNER_MESSAGE =
  "This project needs at least one owner. Grant someone else the Owner role before removing this one."

/**
 * True when dropping this person's direct Owner grant would leave the project
 * with no Owner. Call only when the action removes or demotes a direct row
 * that is currently >= 700. An org Owner still counts, including the person
 * whose direct row is being dropped.
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
         )
            OR EXISTS (
           SELECT 1 FROM org_members om
           JOIN projects p ON p.org_id = om.org_id
            WHERE p.id = ? AND om.role_level >= 700
         )`,
    )
    .bind(projectId, targetUserId, projectId)
    .first<{ ok: number }>()
  return row == null
}
