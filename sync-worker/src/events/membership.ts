// FRO-346: live membership re-check for the write perimeter.
//
// Sync-token verification (auth.ts) is pure JWT: it proves the user had
// project access AT MINT TIME. Removing a member deletes their
// project_members row, but any already-minted token stays valid for up to
// 15 minutes (SYNC_TOKEN_TTL_SECONDS in auth-worker/src/routes/sync-token.ts).
// Without this check, a removed user's outstanding token keeps writing for
// the rest of that window.
//
// Enforcement contract (documented revocation window):
//   - New token mints: refused immediately (auth-worker re-resolves the role
//     from the DB at mint — see resolveProjectRole).
//   - Writes (POST /events): refused immediately by THIS check — the removed
//     user's next flush 403s even with a still-valid token.
//   - Reads: bounded by the 15-minute token TTL (no per-read DB round-trip;
//     matches the FRO-285 frozen-project reasoning in sync-token.ts).
//   - Live WS session: ejected by the ProjectSync DO on the member-removed
//     admin notification (see member-removed.ts / project-do.ts).
//
// Grant paths mirror auth-worker/src/services/project-permissions.ts
// (AD-12): direct project_members, org_members via projects.org_id, group
// grants, creator. Platform operators (ADMIN_EMAILS) have no membership
// rows — their tokens carry `src: "platform"` and callers skip this check
// (the documented platform-admin exemption).

interface MembershipRow {
  project_exists: boolean | number
  has_grant: boolean | number
}

export type MembershipCheck = "ok" | "revoked"

/**
 * Returns "revoked" iff the project row exists AND the user has no grant
 * path left. Fails OPEN in two cases, deliberately:
 *
 *   - Project row missing: the mint-time gate is the only authority (the
 *     sync-token route auto-registers the project row on first mint, so a
 *     real removal always has a row; test/dev fixtures may not).
 *   - Query error: enforcement degrades to the 15-minute token TTL rather
 *     than 500'ing every write during a partial outage (same philosophy as
 *     safeFirst in auth-worker's role resolver).
 */
export async function checkProjectMembership(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<MembershipCheck> {
  try {
    const row = await db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM projects WHERE id = ?) AS project_exists,
           EXISTS (
             SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?
             UNION ALL
             SELECT 1 FROM projects WHERE id = ? AND created_by = ?
             UNION ALL
             SELECT 1 FROM org_members om
               JOIN projects p ON p.org_id = om.org_id
              WHERE p.id = ? AND om.user_id = ?
             UNION ALL
             SELECT 1 FROM group_members gm
               JOIN group_project_grants gpg ON gpg.group_id = gm.group_id
              WHERE gpg.project_id = ? AND gm.user_id = ?
           ) AS has_grant`,
      )
      .bind(
        projectId,
        projectId, userId,
        projectId, userId,
        projectId, userId,
        projectId, userId,
      )
      .first<MembershipRow>()
    if (!row) return "ok"
    const projectExists = row.project_exists === true || row.project_exists === 1
    const hasGrant = row.has_grant === true || row.has_grant === 1
    if (projectExists && !hasGrant) return "revoked"
    return "ok"
  } catch (err) {
    console.warn(
      `[membership] re-check failed for project=${projectId} user=${userId}; failing open to token TTL:`,
      err,
    )
    return "ok"
  }
}
