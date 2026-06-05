/**
 * useMemberAccess — fetches the per-project grant-path breakdown for one org
 * member via GET /api/v2/orgs/:orgId/members/:userId/access (AD-12 max-wins).
 *
 * Re-fetches whenever orgId or userId changes. Returns loading/error/data.
 */
import { useEffect, useState } from "react"
import { getMemberAccess, type MemberEffectiveAccess } from "@/lib/frontier/orgs"
import { useFrontierSession } from "./useFrontierSession"

export type MemberAccessState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "success"; data: MemberEffectiveAccess }

export function useMemberAccess(
  orgId: number | null,
  userId: number | null,
): MemberAccessState {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [state, setState] = useState<MemberAccessState>({ kind: "idle" })

  useEffect(() => {
    if (!jwt || orgId == null || userId == null) {
      setState({ kind: "idle" })
      return
    }
    let cancelled = false
    setState({ kind: "loading" })
    getMemberAccess(jwt, orgId, userId)
      .then((data) => {
        if (!cancelled) setState({ kind: "success", data })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({ kind: "error", error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [jwt, orgId, userId])

  return state
}
