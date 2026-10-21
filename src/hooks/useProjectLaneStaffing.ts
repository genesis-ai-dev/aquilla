import { useCallback, useEffect, useState } from "react"
import { fetchProjectLaneStaffing } from "@/lib/sync/member-scopes"
import type { TeamLaneAttachment } from "@/lib/sync/assignment-lane"

export interface UseProjectLaneStaffing {
  /**
   * The project's target lanes at least one of its people is on, or `null`
   * when the server did not say (below project lead, no lane rows, an older
   * server, a failed read) and while the first read is still in flight.
   * `null` must be read as "unknown", never as "nobody is staffed" — a
   * surface narrowing its lane list leaves the list alone on a `null`.
   */
  staffedLaneIds: ReadonlySet<string> | null
  /**
   * AQU-2047: each attached team's lane checks, or `null` when the server did
   * not say and while the first read is still in flight. `null` and `[]`
   * (no attached team) both leave the lane list alone.
   */
  teamLanes: readonly TeamLaneAttachment[] | null
  /** Re-read staffing and the team lane checks; call it after either changes. */
  refresh: () => void
}

/**
 * AQU-1994: which of a project's target lanes anyone on it can actually work
 * in. Every Assign surface on the project overview narrows its lane list with
 * this, so a manager cannot route work to a language nobody is staffed on.
 *
 * AQU-2047: the same read carries each attached team's lane checks
 * (`teamLanes`). The menu unions those with staffing; this hook only holds
 * what the server said.
 *
 * One GET per load (plus one per `refresh`), not one per member: the server
 * aggregates the lane grants against the live roster, which is also what makes
 * a lane reached only through an attached org Team count.
 *
 * The answer is held against the project + token it was read for, so a
 * project switch reports "unknown" until its own read lands rather than
 * narrowing the new project's lanes with the old project's staffing.
 */
export function useProjectLaneStaffing(
  projectId: string | null,
  jwt: string | null,
  enabled = true,
): UseProjectLaneStaffing {
  const [entry, setEntry] = useState<{
    key: string
    ids: ReadonlySet<string> | null
    teamLanes: readonly TeamLaneAttachment[] | null
  } | null>(null)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const key = enabled && jwt && projectId ? `${projectId}\u0000${jwt}` : null

  useEffect(() => {
    if (!key || !jwt || !projectId) return
    let cancelled = false
    void fetchProjectLaneStaffing(jwt, projectId).then((read) => {
      if (!cancelled) setEntry({
        key,
        ids: read?.staffedLaneIds ?? null,
        teamLanes: read?.teamLanes ?? null,
      })
    })
    return () => { cancelled = true }
  }, [key, jwt, projectId, nonce])

  const current = key != null && entry?.key === key ? entry : null
  return {
    staffedLaneIds: current?.ids ?? null,
    teamLanes: current?.teamLanes ?? null,
    refresh,
  }
}
