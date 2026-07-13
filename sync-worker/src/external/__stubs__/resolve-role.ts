// SWARM-TODO(W1-C): the COMMON contract calls for a shared
// `resolveProjectRoleShared` (live role/membership resolution, per
// AGENT-API §2: "a credential never outlives or exceeds the user's current
// role"), presumably unifying the grant-path logic that today is
// duplicated between auth-worker's project-permissions resolver and this
// worker's `checkProjectMembership` (events/membership.ts, which only
// returns ok/revoked, not a role level). No such shared export existed in
// this worktree at build time, so this is a minimal local stand-in that
// mirrors the same grant paths (direct membership, creator, org membership,
// group grants). Delete this file and repoint the import in
// `read-routes.ts` once the shared resolver lands.

/**
 * Resolve `userId`'s effective role level on `projectId` right now (no
 * caching), taking the MAX across every grant path: direct
 * `project_members`, project creator (implicit OWNER), `org_members` (via
 * the project's org), and `group_project_grants` (via group membership).
 * Returns null when none of those paths grant access — the caller should
 * treat that as `permission_denied`.
 */
export async function resolveProjectRoleShared(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<number | null> {
  const OWNER_LEVEL = 700 // mirrors auth-worker/src/types.ts ROLE.OWNER — project creator is implicit owner.

  const row = await db
    .prepare(
      `SELECT MAX(role_level) AS role_level FROM (
         SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?
         UNION ALL
         SELECT ? AS role_level FROM projects WHERE id = ? AND created_by = ?
         UNION ALL
         SELECT om.role_level FROM org_members om
           JOIN projects p ON p.org_id = om.org_id
          WHERE p.id = ? AND om.user_id = ?
         UNION ALL
         SELECT gpg.role_level FROM group_project_grants gpg
           JOIN group_members gm ON gm.group_id = gpg.group_id
          WHERE gpg.project_id = ? AND gm.user_id = ?
       ) grants`,
    )
    .bind(
      projectId, userId,
      OWNER_LEVEL, projectId, userId,
      projectId, userId,
      projectId, userId,
    )
    .first<{ role_level: number | string | bigint | null }>()

  if (!row || row.role_level == null) return null
  return Number(row.role_level)
}
