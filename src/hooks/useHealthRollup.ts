// AD-14 amendment 2026-06-04 — server-derived health rollup hook.
//
// Fetches confidence-derived health from the server's /health-rollup route
// (propagation over the example-retrieval graph, NOT endorsement_count).
//
// Design: pull-on-change. The hook refetches whenever the set of validated
// cells changes (the only event that shifts health anchors). This is
// intentionally a pull model — the DO broadcast push (health.rollup message)
// is a SWARM-TODO for the next wave (AQU-190).
//
// Local-only projects (no projectId / no jwt): falls back to empty maps
// and the caller uses the endorsement-count path from useHealth.

import { useEffect, useRef, useState } from "react"
import { fetchHealthRollup, type HealthRollupResponse } from "@/lib/sync/health-rollup-read"
import type { CellData } from "./useCells"
import type { DecaySettings } from "@/lib/parsers/types"

export interface UseHealthRollupResult {
  /** Overall project health 0-100. null = not yet loaded. */
  projectHealth: number | null
  /** fileId → file health 0-100. Empty until loaded. */
  fileHealth: Map<string, number>
  /** True while a fetch is in flight. */
  loading: boolean
  /** Last fetch error, if any. */
  error: Error | null
}

export function useHealthRollup(args: {
  projectId?: string
  /** Mints a project-scoped sync-token. */
  getToken?: () => Promise<string | null>
  /** Used to detect when validations change (which anchors to re-fetch on). */
  cells: CellData[]
  decaySettings?: DecaySettings
  enabled: boolean
}): UseHealthRollupResult {
  const { projectId, getToken, cells, decaySettings, enabled } = args

  const [projectHealth, setProjectHealth] = useState<number | null>(null)
  const [fileHealth, setFileHealth] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Refetch key: project + which cells are validated (validation changes anchors;
  // text edits change edges which will be handled when cell_edges materializes).
  const validatedSig = cells
    .filter((c) => c.status === "validated")
    .map((c) => c.id)
    .sort()
    .join(",")

  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  const sig = `${projectId ?? ""}|${validatedSig}|${decaySettings?.maxHops ?? ""}|${decaySettings?.perHopDecay ?? ""}`

  useEffect(() => {
    if (!enabled || !projectId) return

    let cancelled = false
    const ctrl = new AbortController()

    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        const token = await getTokenRef.current?.()
        if (!token || cancelled) return

        const res: HealthRollupResponse = await fetchHealthRollup({
          projectId,
          jwt: token,
          maxHops: decaySettings?.maxHops,
          perHopDecay: decaySettings?.perHopDecay,
          signal: ctrl.signal,
        })

        if (!cancelled) {
          setProjectHealth(res.projectHealth)
          setFileHealth(new Map(Object.entries(res.fileHealth)))
          setError(null)
        }
      } catch (e) {
        if (!cancelled && e instanceof Error && e.name !== "AbortError") {
          setError(e)
          // On error, leave previous values — stale is better than blank.
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, enabled])

  return { projectHealth, fileHealth, loading, error }
}
