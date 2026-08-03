// User lookup + prefix search. Ported from frontier-server's
// `cloudflare/src/services/user-lookup.ts` (origin/main +
// feat/user-search-and-email-invites for the search half).

import type { Env } from "../types"

export interface LookedUpUser {
  id: number
  username: string
}

/**
 * Resolve a username to a user id. Trimmed, exact-match-first, then
 * unambiguous case-insensitive fallback (AQU-457 + hardening):
 *
 *   1. Trim, then try `WHERE username = ?` (exact). A hit is returned
 *      immediately — this alone fixes the original bug (a leading/trailing
 *      space, e.g. pasted from elsewhere, used to cause a false "not found"
 *      against case- and whitespace-sensitive Postgres).
 *   2. If no exact row, fall back to `WHERE LOWER(username) = LOWER(?)`.
 *      Migration 0070 enforces UNIQUE(LOWER(username)), so a case-insensitive
 *      match identifies at most one account. The two-row ceiling remains as
 *      defense in depth: if an invalid legacy fixture or partially migrated
 *      database ever violates that invariant, lookup fails closed instead of
 *      granting access to an arbitrary account.
 */
export async function lookupUserByUsername(
  env: Env,
  username: string,
): Promise<LookedUpUser | null> {
  const trimmed = username.trim()
  if (!trimmed) return null

  const exact = await env.AQUILLA_PG.prepare(
    `SELECT id, username FROM users WHERE username = ? LIMIT 1`,
  )
    .bind(trimmed)
    .first<LookedUpUser>()
  if (exact) return exact

  const ciMatches = await env.AQUILLA_PG.prepare(
    `SELECT id, username FROM users
      WHERE LOWER(username) = LOWER(?)
      ORDER BY id ASC
      LIMIT 2`,
  )
    .bind(trimmed)
    .all<LookedUpUser>()
  const rows = ciMatches.results ?? []
  if (rows.length === 1) return rows[0]
  return null
}

/**
 * Prefix-match users by username for the "Add member" typeahead.
 * Constraints by design:
 *   - Minimum prefix length enforced at the route layer (currently 2).
 *   - Hard ceiling on `limit` enforced at the route layer (currently 25).
 *   - Case-insensitive (COLLATE NOCASE).
 *   - Sorted alphabetically.
 *
 * Auth is enforced upstream (route uses authMiddleware); this service trusts
 * that and runs the SELECT directly.
 */
export async function searchUsersByPrefix(
  env: Env,
  prefix: string,
  limit: number,
): Promise<LookedUpUser[]> {
  const result = await env.AQUILLA_PG.prepare(
    `SELECT id, username FROM users
      WHERE LOWER(username) LIKE LOWER(?) || '%'
      ORDER BY LOWER(username) ASC
      LIMIT ?`,
  )
    .bind(prefix, limit)
    .all<LookedUpUser>()
  return result.results ?? []
}

/**
 * AQU-321: Scoped prefix search — only surfaces users that share an org or
 * project with the caller. Out-of-scope exact-match lookup is handled
 * separately by lookupUserByUsername (which does not confirm-or-deny on miss).
 *
 * Scope: users who are
 *   (a) in any org the caller belongs to (via org_members), OR
 *   (b) a direct/group member of any project the caller holds maintainer+ on.
 *
 * The caller themselves are excluded (no value in seeing yourself).
 */
export async function searchUsersByScopedPrefix(
  env: Env,
  callerId: number,
  prefix: string,
  limit: number,
): Promise<LookedUpUser[]> {
  // Build the scoped universe:
  //   1. Org-overlap: any user sharing an org with the caller.
  //   2. Project-overlap: any user with a direct project_members row on a
  //      project where the caller holds >= maintainer (600).
  // Union of both, prefix-filtered, sorted, limited.
  // Wrap in a subquery so ORDER BY LOWER(username) is unambiguous with DISTINCT.
  const result = await env.AQUILLA_PG.prepare(
    `SELECT id, username FROM (
       SELECT DISTINCT u.id, u.username
         FROM users u
        WHERE LOWER(u.username) LIKE LOWER(?) || '%'
          AND u.id != ?
          AND (
            -- org-overlap: caller and u share at least one org
            EXISTS (
              SELECT 1 FROM org_members caller_om
              JOIN org_members target_om ON target_om.org_id = caller_om.org_id
              WHERE caller_om.user_id = ? AND target_om.user_id = u.id
            )
            OR
            -- project-overlap: u has a direct member row on a project where caller >= 600
            EXISTS (
              SELECT 1 FROM project_members pm_caller
              JOIN project_members pm_target ON pm_target.project_id = pm_caller.project_id
              WHERE pm_caller.user_id = ?
                AND pm_caller.role_level >= 600
                AND pm_target.user_id = u.id
            )
          )
     ) scoped
     ORDER BY LOWER(username) ASC
     LIMIT ?`,
  )
    .bind(prefix, callerId, callerId, callerId, limit)
    .all<LookedUpUser>()
  return result.results ?? []
}
