import { useEffect, useRef, useState } from "react"
import { computeHealthSync, type HealthSyncCell, type HealthSyncResponse } from "@/workers/health-worker-sync"
import type { CellData } from "./useCells"
import type { HealthConfig, TranslationRule } from "@/lib/parsers/types"

export interface UseCompositeHealthInput {
  fileCells: Map<string, CellData[]>
  rules: TranslationRule[]
  config: HealthConfig
  requiredValidations: number
}

export interface UseCompositeHealthResult {
  stats: HealthSyncResponse
  ready: boolean
}

const EMPTY_RESPONSE: HealthSyncResponse = {
  healthMap: new Map(),
  breakdownMap: new Map(),
  fileHealth: new Map(),
  projectHealth: 0,
  infractions: new Map(),
}

/**
 * Lazily create the health Worker.
 * The worker path is built at call-time so Vite's static
 * `new URL("...", import.meta.url)` analyser doesn't bundle the worker's
 * full dependency tree during test transforms (would OOM in happy-dom).
 */
function createHealthWorker(): Worker {
  const workerUrl = new URL("../workers/health-worker.ts", import.meta.url)
  return new Worker(workerUrl, { type: "module" })
}

/** True when running inside Vitest (import.meta.env.VITEST is injected by the framework). */
const isTestEnv: boolean = !!import.meta.env.VITEST

/** Derive a stable cells array from the fileCells Map. */
function buildCells(fileCells: Map<string, CellData[]>): HealthSyncCell[] {
  const cells: HealthSyncCell[] = []
  for (const [fileId, fileCellList] of fileCells) {
    for (const c of fileCellList) {
      cells.push({
        id: c.id,
        fileId,
        original: c.original,
        translated: c.translated,
        validatorCount: c.activeValidators.length,
        history: c.history,
      })
    }
  }
  return cells
}

export function useCompositeHealth(input: UseCompositeHealthInput): UseCompositeHealthResult {
  const [stats, setStats] = useState<HealthSyncResponse>(EMPTY_RESPONSE)
  const [ready, setReady] = useState(false)
  const requestIdRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)

  // Build a stable request using refs so we don't re-fire the effect when the
  // caller passes a new Map/array instance with identical content. We store the
  // last-seen values and only trigger the effect when the derived cell count
  // or content meaningfully differs (via JSON key).
  const prevKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const cells = buildCells(input.fileCells)

    // Compute a cheap content key so we can bail out if nothing really changed.
    // (Avoids infinite loops when the caller creates new Map/array objects on
    // every render but the actual data is unchanged.)
    const key = JSON.stringify([
      cells.map(c => [c.id, c.translated, c.validatorCount]),
      input.requiredValidations,
      input.rules,
    ])
    if (key === prevKeyRef.current) return
    prevKeyRef.current = key

    const request = {
      cells,
      rules: input.rules,
      config: input.config,
      requiredValidations: input.requiredValidations,
    }

    // Prefer Worker when available (real browser build). Skip in test/SSR so
    // Vite doesn't attempt to bundle the worker file inside happy-dom (OOM).
    if (!isTestEnv && typeof Worker !== "undefined") {
      try {
        if (!workerRef.current) {
          workerRef.current = createHealthWorker()
        }
        const w = workerRef.current
        const rid = ++requestIdRef.current
        const handler = (event: MessageEvent<{ id: number; payload: HealthSyncResponse | { error: string } }>) => {
          if (event.data.id !== rid) return
          const p = event.data.payload
          if ("error" in p) {
            console.error("[useCompositeHealth] worker error:", p.error)
            return
          }
          setStats(p)
          setReady(true)
        }
        w.addEventListener("message", handler)
        w.postMessage({ id: rid, payload: request })
        return () => { w.removeEventListener("message", handler) }
      } catch (err) {
        console.error("[useCompositeHealth] Worker init failed, falling back to sync:", err)
        workerRef.current = null
      }
    }

    // Sync fallback: tests, SSR, or Worker init failure.
    const result = computeHealthSync(request)
    setStats(result)
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  useEffect(() => {
    return () => { workerRef.current?.terminate(); workerRef.current = null }
  }, [])

  return { stats, ready }
}
