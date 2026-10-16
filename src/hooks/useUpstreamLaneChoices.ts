// AQU-1605: the upstream lanes a link may consume, for the two flows that make
// a link — Create New Project's wizard and Source & sync's LinkSourceFlow.
//
// Shared rather than duplicated for the reason AQU-1561 gave for the file list:
// the two surfaces ask the same question of the same endpoint, and a second,
// divergent copy is how one of them ends up offering a lane the other refuses.
//
// Plain `useState` + a race-guarded `useEffect`, per AD-3 — never `useQuery`.

import { useCallback, useEffect, useState } from "react"
import {
  loadUpstreamLaneChoices,
  type UpstreamLaneChoice,
} from "@/lib/sync/link-source-preview"

export interface UpstreamLaneChoices {
  /** The lanes this caller may consume, in lane order. `null` while loading —
   *  which is what tells "still loading" from an upstream with no usable lane
   *  (`[]`), a real answer the caller has to say out loud rather than wait on. */
  lanes: UpstreamLaneChoice[] | null
  /** The read failed: the question cannot be answered, so the caller offers a
   *  retry instead of rendering an empty list that reads as "no lanes". */
  failed: boolean
  /** Re-run the read for the same upstream (the "Try again" affordance). */
  retry: () => void
}

export function useUpstreamLaneChoices(
  jwt: string | undefined,
  upstreamProjectId: string,
  /** False while the question does not apply — no upstream picked, or a link
   *  that consumes the upstream's source (one lane, nothing to choose). The
   *  previous answer is dropped, so a cleared picker cannot leave another
   *  upstream's lanes armed. */
  enabled: boolean,
): UpstreamLaneChoices {
  const [lanes, setLanes] = useState<UpstreamLaneChoice[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!enabled || !upstreamProjectId || !jwt) {
      setLanes(null)
      setFailed(false)
      return
    }
    let live = true
    // Dropped before the read, not after it: the list belongs to the upstream
    // being read, so a slow answer for a previous one must never land here.
    setLanes(null)
    setFailed(false)
    void loadUpstreamLaneChoices(jwt, upstreamProjectId)
      .then((next) => {
        if (!live) return
        setLanes(next)
      })
      .catch(() => {
        if (!live) return
        setFailed(true)
      })
    return () => {
      live = false
    }
  }, [enabled, upstreamProjectId, jwt, attempt])

  return { lanes, failed, retry }
}
