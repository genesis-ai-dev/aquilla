// AQU-1029: the signed-in user's own numeric id, resolved WITHOUT the project
// roster.
//
// The frontier session JWT carries `sub` (the username) but no numeric user
// id, while several per-member endpoints are keyed by id —
// `/projects/:projectId/members/:userId/scopes` above all. The existing way to
// bridge that was to look the username up in the project roster
// (`useProjectMembers`), which works for leads and breaks for exactly the
// people those endpoints are about: the roster is gated by the org's
// `rosterViewMinRole` policy (AQU-485), so a scoped contributor or reviewer
// gets a 403 and the lookup silently yields nothing.
//
// `GET /api/v2/auth/me` sits behind plain `authMiddleware` with no
// project-role gate and returns the caller's own record, so any signed-in user
// can resolve their own id from it. Reading one's OWN scopes is viewer (100+),
// so once the id is known the scopes call succeeds for the same people.

import { AUTH_BASE } from "./auth"

/**
 * Per-JWT memo of the in-flight/resolved lookup. The id cannot change for a
 * given token, several hooks may ask at once on a cold project open, and a
 * failed lookup is cached as `null` rather than retried in a loop — a caller
 * that needs to retry should do so on a fresh session.
 */
const byJwt = new Map<string, Promise<number | null>>()

/**
 * The caller's own numeric user id, or `null` when it cannot be determined
 * (network error, non-2xx, or a body without a numeric `id`).
 *
 * Never throws: callers treat `null` as "couldn't determine", which must not
 * be confused with a real answer — in the scopes path it means "don't act",
 * not "unscoped".
 */
export async function fetchMyUserId(
  jwt: string,
  apiUrl: string = AUTH_BASE,
): Promise<number | null> {
  const cached = byJwt.get(jwt)
  if (cached) return cached
  const inFlight = (async (): Promise<number | null> => {
    try {
      const res = await fetch(`${apiUrl}/api/v2/auth/me`, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
      if (!res.ok) {
        console.warn(`[me] GET /auth/me → HTTP ${res.status}`)
        return null
      }
      const body = (await res.json()) as { id?: unknown }
      return typeof body.id === "number" ? body.id : null
    } catch (err) {
      console.warn("[me] GET /auth/me failed:", err)
      return null
    }
  })()
  byJwt.set(jwt, inFlight)
  return inFlight
}

/** Drop the memo. Exported for tests and for sign-out paths that reuse a tab. */
export function resetMyUserIdCache(): void {
  byJwt.clear()
}
