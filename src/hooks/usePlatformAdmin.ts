import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { peekPlatformAdmin, probePlatformAdmin } from "@/lib/frontier/platform-admin-probe"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"

/**
 * Resolves whether the current session is a platform operator (site-wide
 * admin). UX gate only — the worker enforces the real boundary on every
 * /api/v2/admin/* call. `isAdmin` stays false until the probe resolves, so
 * the admin nav entry / route never flashes for ordinary users.
 *
 * Follows the useOrg fetch convention: setState lives in a useCallback, the
 * effect just kicks it off, and an aliveRef guards against StrictMode's
 * setup→cleanup→setup dry-run (see useOrg.ts for the full rationale).
 *
 * The probe itself is shared (`platform-admin-probe.ts`): every consumer on a
 * page joins one request, and a consumer that mounts while the answer is still
 * fresh starts settled — no request, no loading frame, no extra commit.
 */
export function usePlatformAdmin(): { isAdmin: boolean; loading: boolean } {
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [isAdmin, setIsAdmin] = useState(() => (jwt ? peekPlatformAdmin(jwt) ?? false : false))
  const [loading, setLoading] = useState(() => !jwt || peekPlatformAdmin(jwt) === undefined)
  const aliveRef = useRef(true)
  const requestRef = useRef(0)
  const jwtRef = useRef(jwt)
  jwtRef.current = jwt

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    if (!jwt) {
      // No JWT yet. If the session is still hydrating, stay in the loading
      // state — concluding "not admin" here would let route guards redirect a
      // real admin before their session loads. Only settle to false once the
      // session has resolved and there is genuinely no logged-in user.
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) {
        setIsAdmin(false)
        setLoading(sessionLoading)
      }
      return
    }
    const known = peekPlatformAdmin(jwt)
    if (known !== undefined) {
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) {
        setIsAdmin(known)
        setLoading(false)
      }
      return
    }
    if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setLoading(true)
    try {
      const ok = await probePlatformAdmin(jwt)
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setIsAdmin(ok)
    } catch (err) {
      if (err instanceof UserError && err.category === "session-expired") {
        void notifySessionExpiredIfCurrent(jwt)
      }
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setIsAdmin(false)
    } finally {
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setLoading(false)
    }
  }, [jwt, sessionLoading])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { isAdmin, loading }
}
