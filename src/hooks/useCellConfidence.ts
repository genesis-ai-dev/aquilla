import { useEffect, useRef, useState } from "react"
import type { CellSummary } from "./useActiveCellStore"
import { fetchCellConfidence } from "@/lib/sync/cell-confidence-read"

// PROTOTYPE (AD-14 health-as-confidence). Derives per-cell health on read from
// FTS5 similarity to validated cells, instead of the stored endorsement_count.
// Runs alongside the endorsement path for comparison; nothing is removed.
//
// Cost is one FTS5 MATCH per translated-unvalidated cell, so we cap the batch —
// this is a viewport-scoped read, not an all-cells aggregate.
const MAX_QUERY_CELLS = 100

export interface CellConfidenceResult {
  /** cellId → health 0..100. validated→100, untranslated→0, else server-derived. */
  healthMap: Map<string, number>
  /** cellId → the best-covering validated neighbor (observability). */
  topNeighbor: Map<string, string | null>
  /** Latency of the last server batch, for measuring. */
  lastTookMs: number | null
}

/**
 * Optimistic + lazy: validated cells read 100 and untranslated read 0
 * immediately (local knowledge), so a just-validated cell snaps up with no
 * round-trip; the server confidence for translated-unvalidated cells loads in
 * and adjusts. Refetches when the set of cells or their validation state
 * changes (self-healing against edits and validations).
 */
export function useCellConfidence(args: {
  projectId?: string
  fileId?: string
  /** Mints a project-scoped sync-token (NOT the raw session JWT). */
  getToken?: () => Promise<string | null>
  cells: readonly CellSummary[]
  enabled: boolean
  /** Per-hop authority decay (project setting); server defaults to 0.8. */
  perHopDecay?: number
}): CellConfidenceResult {
  const { projectId, fileId, getToken, cells, enabled, perHopDecay } = args
  const [healthMap, setHealthMap] = useState<Map<string, number>>(new Map())
  const [topNeighbor, setTopNeighbor] = useState<Map<string, string | null>>(new Map())
  const [lastTookMs, setLastTookMs] = useState<number | null>(null)

  // AQU-646: `status` alone no longer implies "has text" — a line carrying only
  // a recording now reads as unvalidated rather than empty. Confidence is a
  // TEXT model, so it needs the text test explicitly or every dubbed-but-
  // unwritten line would be sent to the scorer with nothing to score.
  const toQuery = cells
    .filter((c) => c.status !== "validated" && c.status !== "empty" && Boolean(c.translated?.trim()))
    .map((c) => c.id)
    .slice(0, MAX_QUERY_CELLS)

  // Refetch key: file + which cells are validated (ground-truth anchors that
  // ripple out and shift neighbors' health) + which cells still need a score.
  const validatedSig = cells
    .filter((c) => c.status === "validated")
    .map((c) => c.id)
    .join(",")
  const sig = `${projectId}|${fileId}|${validatedSig}|${toQuery.join(",")}|${perHopDecay ?? ""}`

  const cellsRef = useRef(cells)
  cellsRef.current = cells
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  useEffect(() => {
    // Fully inert when disabled: no state writes at all, so the editor renders
    // exactly as it would without this hook (the overlay is opt-in — see the
    // flag in ProjectWorkspace).
    if (!enabled) return

    // Optimistic local seed (instant, no round-trip): a just-validated cell
    // snaps to 100 immediately, then the server ripple adjusts its neighbors.
    // Untranslated cells are skipped (not started — they fall through to the
    // endorsement health rather than being scored).
    const base = new Map<string, number>()
    for (const c of cellsRef.current) {
      if (c.status === "validated") base.set(c.id, 100)
    }
    setHealthMap(base)

    if (!projectId || !fileId || toQuery.length === 0) return

    const ctrl = new AbortController()
    ;(async () => {
      const token = await getTokenRef.current?.()
      if (!token || ctrl.signal.aborted) return
      try {
        const res = await fetchCellConfidence({ projectId, fileId, jwt: token, cellIds: toQuery, perHopDecay, signal: ctrl.signal })
        setHealthMap((prev) => {
          const next = new Map(prev)
          for (const [cid, conf] of Object.entries(res.confidence)) {
            next.set(cid, Math.round(conf * 100))
          }
          return next
        })
        setTopNeighbor(() => {
          const next = new Map<string, string | null>()
          for (const [cid, d] of Object.entries(res.detail)) {
            next.set(cid, d.topCellId)
          }
          return next
        })
        setLastTookMs(res.tookMs)
      } catch (e) {
        if (e instanceof Error && e.name !== "AbortError") {
          console.warn("[cell-confidence] fetch failed:", e.message)
        }
      }
    })()
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, enabled])

  return { healthMap, topNeighbor, lastTookMs }
}
