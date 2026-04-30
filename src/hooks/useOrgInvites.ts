import { useCallback, useEffect, useRef, useState } from "react"
import {
  listPendingOrgInvites,
  revokeProjectInvite,
  type PendingOrgInvite,
} from "@/lib/frontier/orgs"
import { useFrontierSession } from "./useFrontierSession"

export interface UseOrgInvites {
  /** Server-confirmed pending invites for this org. null while loading or
   * when the caller isn't an org owner (server gates the listing to
   * owners — non-owners get null and the page hides the section). */
  invites: PendingOrgInvite[] | null
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Optimistically remove an invite from the local list, fire DELETE, and
   * snap back if it fails. Returns true when the server confirmed the
   * revoke, false when the row was already gone (idempotent miss). */
  revoke: (projectId: string, token: string) => Promise<boolean>
}

/**
 * Pending project invites scoped to one org. Used by the operational PM
 * Members page's "Pending invitations" section. Owner-only server-side;
 * non-owner callers see the section disappear (null state) rather than an
 * error — same defensive pattern as listProjectMembers' null-on-403.
 */
export function useOrgInvites(orgId: number | null): UseOrgInvites {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [invites, setInvites] = useState<PendingOrgInvite[] | null>(null)
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => () => { aliveRef.current = false }, [])

  const refresh = useCallback(async () => {
    if (!jwt || orgId == null) {
      if (aliveRef.current) {
        setInvites(null)
        setError(null)
      }
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await listPendingOrgInvites(jwt, orgId)
      if (aliveRef.current) setInvites(next)
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, orgId])

  useEffect(() => { void refresh() }, [refresh])

  const revoke = useCallback(
    async (projectId: string, token: string) => {
      if (!jwt) return false
      // Optimistically drop the row from local state. If the server returns
      // an error we re-fetch to restore. Most failures here are network
      // blips or "already revoked elsewhere" (which the server reports as
      // removed=false but we still want to drop locally — it's gone either
      // way).
      setInvites((prev) =>
        prev ? prev.filter((inv) => inv.token !== token) : prev
      )
      try {
        const removed = await revokeProjectInvite(jwt, projectId, token)
        return removed
      } catch (e) {
        await refresh()
        if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [jwt, refresh]
  )

  return { invites, isLoading, error, refresh, revoke }
}
