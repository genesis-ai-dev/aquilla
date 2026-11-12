// AQU-346: live membership re-check for the write perimeter.
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
//     matches the AQU-285 frozen-project reasoning in sync-token.ts).
//   - Live WS session: ejected by the ProjectSync DO on the member-removed
//     admin notification (see member-removed.ts / project-do.ts).
//
// Grant paths are resolved by the SHARED max-wins resolver in
// db/shared/project-roles.ts (AD-12) — the same one auth-worker mints the
// sync token from and the Agent API authority already uses. It encodes the
// AQU-435 org floor, the AQU-1274 org-path rule, the creator path and the
// `ACCESS_GRANTS_RESOLVER` view mode once, in one place.
//
// AQU-1787: this check used to carry its OWN copy of the grant SQL, which
// counted `org_members` at ROLE.MAINTAINER+ only (the AQU-435 rule alone).
// AQU-1274 then taught the mint-side resolver that a sub-Maintainer org role
// DOES contribute when a team grant opens the project and there is no direct
// project row — and never taught this query. The two resolvers disagreed by
// exactly that case: an org Project Lead (500) reaching a project through a
// team attached at Contributor (400) got a token claiming 500 and a live
// re-resolve of 400, so the AQU-1331 downgrade gate 403'd every write with
// "role downgraded since token was issued". Resolving through the shared
// resolver means the mint side and the write perimeter cannot drift again.
//
// Platform operators (ADMIN_EMAILS) have no membership rows — their tokens
// carry `src: "platform"` and callers skip this check (the documented
// platform-admin exemption). The shared resolver's own ADMIN_EMAILS path is
// therefore deliberately NOT used here: this check answers "what do this
// user's membership rows say", exactly as before.

import { resolveProjectRoleIncludingArchivedShared } from "../../../db/shared/project-roles"

export type MembershipCheck = "ok" | "revoked"

export interface MembershipDetail {
  status: MembershipCheck
  /**
   * [Pen test 2026-09-21] Live-resolved MAX role_level across every grant
   * path (direct membership, creator, qualifying org membership, group
   * grant), or null when there is no grant to resolve (project missing,
   * fully revoked, or the query failed open). Lets a caller catch a
   * DOWNGRADE (role_level lowered, not removed) that `status` alone can't
   * see — see checkProjectMembership's doc comment for why a plain
   * ok/revoked check misses this.
   */
  roleLevel: number | null
}

/**
 * Returns "revoked" iff the project row exists AND the user has no grant
 * path left. Fails OPEN in two cases, deliberately:
 *
 *   - Project row missing: the mint-time gate is the only authority. AQU-299 /
 *     SEC-9: the sync-token route now 403s an unknown projectId instead of
 *     auto-registering it, so a live project always has a row by the time any
 *     event reaches here and a real removal always has one; test/dev fixtures
 *     may not.
 *   - Query error: enforcement degrades to the 15-minute token TTL rather
 *     than 500'ing every write during a partial outage (same philosophy as
 *     safeFirst in auth-worker's role resolver).
 *
 * [Pen test 2026-09-21] This ok/revoked signal only catches full removal. A
 * DIRECT project_members row that is downgraded rather than deleted (e.g.
 * OWNER -> VIEWER) still has_grant, so this alone reports "ok" and a
 * still-valid token keeps writing at its old, now-stale role for the rest of
 * its 15-minute lifetime. Callers on the write perimeter should prefer
 * checkProjectMembershipDetailed and compare its roleLevel against the
 * token's claimed role to close that gap.
 */
export async function checkProjectMembership(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<MembershipCheck> {
  return (await checkProjectMembershipDetailed(db, projectId, userId)).status
}

/**
 * Same enforcement contract as checkProjectMembership, but also returns the
 * live-resolved role level so a write-perimeter caller can detect a
 * DOWNGRADE (not just a full removal) of the token's claimed role. See the
 * MembershipDetail doc comment.
 */
export async function checkProjectMembershipDetailed(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<MembershipDetail> {
  try {
    // Independent reads. The resolver answers "what level, if any"; it
    // returns null both for a missing project and for a fully revoked user,
    // and only the second of those is a revocation — hence the separate
    // existence probe. `IncludingArchived` keeps this check's long-standing
    // contract: archiving a project is not a membership revocation, so an
    // in-flight write to a just-trashed project still fails open to the
    // token TTL rather than being reported as a downgrade.
    const [projectRow, resolved] = await Promise.all([
      db
        .prepare(`SELECT 1 AS present FROM projects WHERE id = ?`)
        .bind(projectId)
        .first<{ present: number }>(),
      // No adminEmails: see the platform-admin note in the file header.
      // No explicit mode: the shared resolver reads ACCESS_GRANTS_RESOLVER
      // off the request db handle, which sync-worker's fetch registers.
      resolveProjectRoleIncludingArchivedShared(db, { id: String(userId) }, projectId),
    ])
    const roleLevel = resolved?.level ?? null
    if (projectRow != null && roleLevel === null) return { status: "revoked", roleLevel: null }
    return { status: "ok", roleLevel }
  } catch (err) {
    console.warn(
      `[membership] re-check failed for project=${projectId} user=${userId}; failing open to token TTL:`,
      err,
    )
    return { status: "ok", roleLevel: null }
  }
}
