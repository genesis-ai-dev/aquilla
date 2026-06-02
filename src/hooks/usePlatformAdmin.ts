import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getAdminMe } from "@/lib/frontier/admin"

/**
 * Resolves whether the current session is a platform operator (site-wide
 * admin). UX gate only — the worker enforces the real boundary on every
 * /api/v2/admin/* call. `isAdmin` stays false until the probe resolves, so
 * the admin nav entry / route never flashes for ordinary users.
 *
 * Follows the useOrg fetch convention: setState lives in a useCallback, the
 * effect just kicks it off, and an aliveRef guards against StrictMode's
 * setup→cleanup→setup dry-run (see useOrg.ts for the full rationale).
 */
export function usePlatformAdmin(): { isAdmin: boolean; loading: boolean } {
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!jwt) {
      // No JWT yet. If the session is still hydrating, stay in the loading
      // state — concluding "not admin" here would let route guards redirect a
      // real admin before their session loads. Only settle to false once the
      // session has resolved and there is genuinely no logged-in user.
      if (aliveRef.current) {
        setIsAdmin(false)
        setLoading(sessionLoading)
      }
      return
    }
    if (aliveRef.current) setLoading(true)
    try {
      const ok = await getAdminMe(jwt)
      if (aliveRef.current) setIsAdmin(ok)
    } catch {
      if (aliveRef.current) setIsAdmin(false)
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, sessionLoading])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { isAdmin, loading }
}
