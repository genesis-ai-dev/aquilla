import { useEffect, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { laneRowLabel } from "@/lib/lanes/lane-language"
import { fetchProjectSettingsResult } from "@/lib/sync/project-settings"

export interface TargetLaneOption {
  id: string
  label: string
}

/**
 * Current (non-archived) target lanes the sharer can grant. A failed load
 * stays empty so the form does not invent a lane list; the server still
 * refuses a below-lead add that names no choice when lanes exist.
 */
export function useCurrentTargetLanes(projectId: string | null): {
  lanes: TargetLaneOption[]
  ready: boolean
} {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [lanes, setLanes] = useState<TargetLaneOption[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const requestKey = projectId && jwt ? `${jwt}\0${projectId}` : null

  useEffect(() => {
    if (!projectId || !jwt || !requestKey) return
    let alive = true
    void (async () => {
      try {
        const result = await fetchProjectSettingsResult(jwt, projectId)
        if (!alive) return
        const rows = result.ok ? (result.value?.lanes ?? []) : []
        setLanes(
          rows
            .filter((lane) => lane.role === "target" && !lane.archivedAt)
            .map((lane) => ({
              id: lane.id,
              label: laneRowLabel(lane) ?? lane.legacyTag ?? lane.id,
            })),
        )
      } catch {
        if (!alive) return
        setLanes([])
      }
      if (alive) setLoadedFor(requestKey)
    })()
    return () => {
      alive = false
    }
  }, [jwt, projectId, requestKey])

  // A missing session or project is not "loaded empty". Callers that submit
  // anyway still meet the server's refusal when the project has lanes.
  return { lanes: loadedFor === requestKey ? lanes : [], ready: loadedFor === requestKey }
}
