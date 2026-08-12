/**
 * AQU-885: expired-JWT boot gate.
 *
 * The stored session keeps its JWT until some request 401s, so reloading after
 * the token lapsed booted the workspace normally, fired the organizations and
 * project-directory fetches with a dead token, and left the user on an empty
 * all-orgs dashboard with no org picker — even though the `exp` claim made the
 * expiry knowable client-side before any request went out.
 *
 * This gate reads the stored session at boot (and on account switch, since it
 * re-renders with the newly active session) and, on the signed-in shell routes,
 * redirects straight to `/login?next=<current path>`. `OrgProvider` runs the
 * same expiry check before its own fetches, so no doomed request is issued in
 * the render before the redirect lands.
 *
 * Deliberately narrow about where it redirects:
 *  - Public routes (`/login`, `/join/:token`, `/join-org/:token`, `/link/:token`,
 *    `/approve/:id`, `/verify-email`, …) are reachable signed-out and already
 *    handle an expired session in place (see JoinPage / JoinOrgPage). Bouncing
 *    them would drop the token carried in the URL.
 *  - The project workspace (`/project/:id/...`) is excluded too: it supports
 *    working offline on already-synced content, and a hard redirect there would
 *    evict someone mid-edit with no way back until they can reach the server.
 *    Those surfaces keep the AQU-293 session-expired banner.
 */

import { Navigate, useLocation } from "react-router-dom"
import { useAccounts } from "@/hooks/useAccounts"
import { isJwtExpired } from "@/lib/frontier/auth"

/** Signed-in shell routes whose whole purpose is server-backed org/project data. */
const GUARDED_EXACT = new Set(["/", "/app", "/shared"])
const GUARDED_PREFIXES = ["/orgs", "/projects"]

/** True for the routes {@link ExpiredSessionGate} redirects away from. */
export function isSessionGuardedPath(pathname: string): boolean {
  if (GUARDED_EXACT.has(pathname)) return true
  return GUARDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function ExpiredSessionGate() {
  const { active, loading } = useAccounts()
  const location = useLocation()

  // Never act before the stored session has been read — a redirect on the
  // pre-hydration null would bounce every signed-in cold load to /login.
  if (loading || !active || !isJwtExpired(active.jwt)) return null
  if (!isSessionGuardedPath(location.pathname)) return null

  const next = encodeURIComponent(location.pathname + location.search)
  return <Navigate to={`/login?next=${next}`} replace />
}
