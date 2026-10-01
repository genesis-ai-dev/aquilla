import { useEffect, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { MemberAccess } from "@/lib/access/types"
import { fetchMemberAccess, type AccessFromScope } from "@/lib/sync/access-read"
import { UserError } from "@/lib/errors/user-error"

export type MemberInspectorAccessState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: MemberAccess }
  | { status: "error"; forbidden: boolean }

/**
 * AQU-1352 §3.8: the inspector's read (GET /users/:id/access). Distinct from
 * useMemberAccess, which is the older org per-project breakdown. Plain useState + race-guarded effect
 * (repo rule: no React Query hooks). Pass `userId = null` to stay idle, so a
 * closed popover costs nothing.
 */
export function useMemberInspectorAccess(userId: number | string | null, from: AccessFromScope): MemberInspectorAccessState {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [state, setState] = useState<MemberInspectorAccessState>({ status: "idle" })

  useEffect(() => {
    if (userId == null || !jwt) {
      setState({ status: "idle" })
      return
    }
    let cancelled = false
    setState({ status: "loading" })
    fetchMemberAccess(jwt, userId, from).then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data })
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", forbidden: err instanceof UserError && err.status === 403 })
      },
    )
    return () => {
      cancelled = true
    }
  }, [jwt, userId, from.type, from.id]) // eslint-disable-line react-hooks/exhaustive-deps -- `from` identified by its fields

  return state
}
