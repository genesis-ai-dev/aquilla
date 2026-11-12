import { useEffect, useRef, useState } from "react"
import { useFrontierSession } from "./useFrontierSession"
import { fetchMyScopeGrant, type MemberScope, type MyScopeGrant } from "@/lib/sync/member-scopes"

/**
 * AQU-633: the CURRENT user's own lane/file scopes for a project, so the editor
 * can gate the Validate affordance on out-of-scope cells (mirroring the
 * sync-worker's enforceScopes) instead of offering a guaranteed-403 action.
 *
 * AQU-581: this asks the server for `me` rather than resolving the caller's
 * numeric id from the project roster. The roster route is gated by the org's
 * `rosterViewMinRole`, which defaults to MAINTAINER (600) — so for a
 * CONTRIBUTOR (400) it 403s, the id came back null, and this hook returned []
 * without ever calling the scopes endpoint. That was invisible for AQU-633
 * (where [] means "unscoped", i.e. permissive) but wrong for the AQU-581 lane
 * delegate grant (where [] means "no lanes", i.e. no assign UI at all) — the
 * feature was unusable by exactly the below-lead role it exists to serve.
 *
 * Returns `[]` while loading and when the scopes fetch fails. Note that the
 * two consumers read that empty value in OPPOSITE directions, so a caller that
 * treats scopes as a GRANT rather than a RESTRICTION must not assume `[]` is
 * safe — the server stays authoritative either way.
 */
export function useMyScopes(projectId: string | null): MemberScope[] {
  return useMyScopeGrant(projectId).scopes
}

const EMPTY_GRANT: MyScopeGrant = { scopes: [], allowScopedLaneAssignment: null }

/**
 * The caller's own scopes AND whether the project's org lets lane-limited
 * members assign work, from one request. The second half is how a GUEST (a
 * project member outside the org, e.g. an outside mentor) learns the setting:
 * they can't read the org's settings, so the org-settings read says "off"
 * (AQU-581 review). `allowScopedLaneAssignment` is `null` until known.
 */
export function useMyScopeGrant(projectId: string | null): MyScopeGrant {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [grant, setGrant] = useState<MyScopeGrant>(EMPTY_GRANT)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    // Resolve asynchronously (never a synchronous setState in the effect body):
    // when any input is missing, this collapses to the empty grant and also
    // resets stale scopes on a project/account switch.
    const load = async () => {
      const next = !jwt || !projectId ? EMPTY_GRANT : ((await fetchMyScopeGrant(jwt, projectId)) ?? EMPTY_GRANT)
      if (!cancelled && aliveRef.current) setGrant(next)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [jwt, projectId])

  return grant
}
