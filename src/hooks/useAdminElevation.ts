import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getAdminStatus, type AdminMe } from "@/lib/frontier/admin"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"

export interface AdminElevationState {
  /** Allowlisted (and domain-matching, when hardened) platform admin. */
  isAdmin: boolean
  /** The admin's account email (where step-up codes are sent). */
  email: string | null
  /** Whether the console requires the step-up email-code gate. */
  hardened: boolean
  /** A valid elevated session exists (always true when not hardened). */
  isElevated: boolean
  /** ISO expiry of the current elevated session, if any. */
  elevatedUntil: string | null
  loading: boolean
  /** Re-probe /me — call after a successful verify to flip into the console. */
  refresh: () => Promise<void>
}

/**
 * Admin identity + step-up elevation status from a single GET /api/v2/admin/me
 * probe. UX gate only — the worker enforces both the allowlist+domain and the
 * elevation requirement on every /api/v2/admin/* call. Mirrors usePlatformAdmin's
 * aliveRef + jwt-gated fetch convention (see useOrg.ts for the StrictMode note).
 */
export function useAdminElevation(): AdminElevationState {
  const { session, loading: sessionLoading } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [me, setMe] = useState<AdminMe | null>(null)
  const [loading, setLoading] = useState(true)
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
      // Don't conclude "not admin" while the session is still hydrating.
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) {
        setMe(null)
        setLoading(sessionLoading)
      }
      return
    }
    if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setLoading(true)
    try {
      const status = await getAdminStatus(jwt)
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setMe(status)
    } catch (err) {
      if (err instanceof UserError && err.category === "session-expired") {
        void notifySessionExpiredIfCurrent(jwt)
      }
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setMe(null)
    } finally {
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setLoading(false)
    }
  }, [jwt, sessionLoading])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return {
    isAdmin: me !== null,
    email: me?.email ?? null,
    hardened: me?.hardened ?? false,
    isElevated: me?.elevated ?? false,
    elevatedUntil: me?.elevatedUntil ?? null,
    loading,
    refresh,
  }
}
