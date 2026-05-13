// User lookup + prefix search. Ported from frontier-server's
// `cloudflare/src/services/user-lookup.ts` (origin/main +
// feat/user-search-and-email-invites for the search half).

import type { Env } from "../types"

export interface LookedUpUser {
  id: number
  username: string
}

/**
 * Resolve a username to a user id. Case-sensitive on purpose — matches the
 * auth login path (`SELECT * FROM users WHERE username = ?`). A miss returns
 * null; callers translate that into a 404 at the HTTP layer.
 */
export async function lookupUserByUsername(
  env: Env,
  username: string,
): Promise<LookedUpUser | null> {
  const row = await env.AQUILLA_DB.prepare(
    "SELECT id, username FROM users WHERE username = ?",
  )
    .bind(username)
    .first<LookedUpUser>()
  return row
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
  const result = await env.AQUILLA_DB.prepare(
    `SELECT id, username FROM users
      WHERE username LIKE ? || '%' COLLATE NOCASE
      ORDER BY username COLLATE NOCASE ASC
      LIMIT ?`,
  )
    .bind(prefix, limit)
    .all<LookedUpUser>()
  return result.results ?? []
}
