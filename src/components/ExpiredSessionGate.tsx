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
 *  - Every route under `/project/:id/...`, including settings, stays available
 *    offline. Project settings hydrate from IDB and deliberately permit local
 *    edits while disconnected; these surfaces keep the expiry banner instead.
 */

import { useEffect, useState } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useAccounts } from "@/hooks/useAccounts"
import { isJwtExpired } from "@/lib/frontier/auth"
import { loadActiveSession } from "@/lib/frontier/session-store"
import { loginPath } from "@/lib/navigation/login-path"

/** Signed-in routes whose whole purpose is server-backed account/org/project data. */
const GUARDED_EXACT = new Set(["/", "/app", "/shared", "/admin"])
const GUARDED_PREFIXES = ["/orgs", "/projects"]

/** True for the routes {@link ExpiredSessionGate} redirects away from. */
export function isSessionGuardedPath(pathname: string): boolean {
  if (GUARDED_EXACT.has(pathname)) return true
  return GUARDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function ExpiredSessionGate() {
  const { active, loading } = useAccounts()
  const location = useLocation()

  const candidateJwt =
    !loading && active && isJwtExpired(active.jwt) && isSessionGuardedPath(location.pathname)
      ? active.jwt
      : null

  if (!candidateJwt) return null
  return (
    <ConfirmedExpiredRedirect
      jwt={candidateJwt}
      next={location.pathname + location.search}
    />
  )
}

function ConfirmedExpiredRedirect({ jwt, next }: { jwt: string; next: string }) {
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadActiveSession().then((stored) => {
      if (!cancelled && stored?.jwt === jwt && isJwtExpired(stored.jwt)) {
        setConfirmed(true)
      }
    }).catch(() => {
      if (!cancelled) setConfirmed(true)
    })
    return () => { cancelled = true }
  }, [jwt])

  if (!confirmed) return null
  // A locally expired JWT does not need an explicit reauth override: Login
  // already shows the form for it. Omitting the flag lets a token refreshed by
  // another tab between confirmation and navigation recover automatically.
  return <Navigate to={loginPath({ next })} replace />
}
