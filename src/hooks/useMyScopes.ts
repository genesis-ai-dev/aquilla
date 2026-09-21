import { useEffect, useRef, useState } from "react"
import { useFrontierSession } from "./useFrontierSession"
import { fetchMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"

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
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [scopes, setScopes] = useState<MemberScope[]>([])
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
    // when any input is missing, this collapses to [] and also resets stale
    // scopes on a project/account switch.
    const load = async () => {
      const next =
        !jwt || !projectId ? [] : ((await fetchMemberScopes(jwt, projectId, "me")) ?? [])
      if (!cancelled && aliveRef.current) setScopes(next)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [jwt, projectId])

  return scopes
}
