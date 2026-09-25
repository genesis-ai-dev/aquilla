import { useEffect, useRef, useState } from "react"
import { useFrontierSession } from "./useFrontierSession"
import { useProjectMembers } from "./useProjectMembers"
import { fetchMyUserId } from "@/lib/frontier/me"
import { fetchMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"

/**
 * AQU-633: the CURRENT user's own lane/file scopes for a project, so the editor
 * can gate the Validate affordance on out-of-scope cells (mirroring the
 * sync-worker's enforceScopes) instead of offering a guaranteed-403 action.
 *
 * The frontier session has no numeric userId and `/members/:id/scopes` is keyed
 * by id, so the caller's id has to be resolved first.
 *
 * AQU-1029: that resolution used to read the id out of the project roster by
 * username, which fails for precisely the people who HAVE scopes. The roster is
 * gated by the org's `rosterViewMinRole` policy (AQU-485), so a scoped
 * contributor or reviewer gets a 403, `members` stays empty, the id never
 * resolves, and the scopes fetch is never issued — the hook reports "unscoped"
 * for the one population that is scoped. QA caught this on a preview: a
 * contributor scoped to a non-default lane read as `[]` while the server still
 * held their lane scope. `/auth/me` (plain auth, no project-role gate) is
 * therefore the primary source, with the roster kept as a fallback for a
 * caller that already has it loaded.
 *
 * Returns `[]` (unscoped → no gating) while loading, when the id cannot be
 * resolved at all, or when the scopes fetch fails — the server stays
 * authoritative and a genuine refusal still surfaces via the outbox 403 path,
 * so a permissive fallback never hides an allowed action.
 */
export function useMyScopes(projectId: string | null): MemberScope[] {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null
  const { members } = useProjectMembers(projectId)
  const rosterUserId =
    username != null ? (members.find((m) => m.username === username)?.userId ?? null) : null
  const [meUserId, setMeUserId] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    // Resolve asynchronously (never a synchronous setState in the effect body,
    // matching the scopes effect below): with no jwt this collapses to null,
    // which also clears a stale id on sign-out or an account switch.
    const load = async () => {
      const next = jwt ? await fetchMyUserId(jwt) : null
      if (!cancelled) setMeUserId(next)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [jwt])
  // Prefer whichever resolved. The roster answer arrives free for a lead who
  // already loaded it; `/auth/me` is the one that works for a scoped member.
  const myUserId = rosterUserId ?? meUserId

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
