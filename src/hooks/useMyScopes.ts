import { useEffect, useRef, useState } from "react"
import { useFrontierSession } from "./useFrontierSession"
import { useProjectMembers } from "./useProjectMembers"
import { fetchMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"

/**
 * AQU-633: the CURRENT user's own lane/file scopes for a project, so the editor
 * can gate the Validate affordance on out-of-scope cells (mirroring the
 * sync-worker's enforceScopes) instead of offering a guaranteed-403 action.
 *
 * The frontier session has no numeric userId, and `/members/:id/scopes` is
 * keyed by id, so we resolve the caller's id from the project roster by
 * username. Returns `[]` (unscoped → no gating) while loading, when the roster
 * is unavailable, or when the scopes fetch fails — the server stays
 * authoritative and a genuine refusal still surfaces via the outbox 403 path,
 * so a permissive fallback never hides an allowed action.
 */
export function useMyScopes(projectId: string | null): MemberScope[] {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null
  const { members } = useProjectMembers(projectId)
  const myUserId =
    username != null ? (members.find((m) => m.username === username)?.userId ?? null) : null

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
    // when any input is missing, this collapses to [] — the unscoped/permissive
    // fallback — and also resets stale scopes on a project/account switch.
    const load = async () => {
      const next =
        !jwt || !projectId || myUserId == null
          ? []
          : (await fetchMemberScopes(jwt, projectId, myUserId)) ?? []
      if (!cancelled && aliveRef.current) setScopes(next)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, myUserId])

  return scopes
}
