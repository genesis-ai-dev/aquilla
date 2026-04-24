import { useEffect, useRef, useState } from "react"
import { computeHealthSync, type HealthSyncCell, type HealthSyncRequest, type HealthSyncResponse } from "@/workers/health-worker-sync"
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

// Trailing debounce so a burst of keystrokes collapses into a single
// recompute. Health feedback is advisory; a quarter-second of lag is
// imperceptible but eliminates per-keystroke worker traffic.
const HEALTH_DEBOUNCE_MS = 200

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
  const prevKeyRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRequestRef = useRef<HealthSyncRequest | null>(null)

  // Worker setup + teardown runs once. A single persistent message listener
  // dispatches responses by request id so we don't leak listeners across the
  // many recomputes a long-lived editor session triggers.
  useEffect(() => {
    if (!isTestEnv && typeof Worker !== "undefined") {
      try {
        const w = createHealthWorker()
        w.onmessage = (event: MessageEvent<{ id: number; payload: HealthSyncResponse | { error: string } }>) => {
          if (event.data.id !== requestIdRef.current) return
          const p = event.data.payload
          if ("error" in p) {
            console.error("[useCompositeHealth] worker error:", p.error)
            return
          }
          setStats(p)
          setReady(true)
        }
        workerRef.current = w
      } catch (err) {
        console.error("[useCompositeHealth] Worker init failed, falling back to sync:", err)
        workerRef.current = null
      }
    }
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    const cells = buildCells(input.fileCells)

    // Cheap content key so we bail out when a new Map/array is passed with
    // identical content (avoids infinite re-renders).
    const key = JSON.stringify([
      cells.map(c => [
        c.id,
        c.translated,
        c.validatorCount,
        c.history.length,
        c.history.at(-1)?.examples,
      ]),
      input.requiredValidations,
      input.rules,
      input.config,
    ])
    if (key === prevKeyRef.current) return
    prevKeyRef.current = key

    pendingRequestRef.current = {
      cells,
      rules: input.rules,
      config: input.config,
      requiredValidations: input.requiredValidations,
    }

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      const req = pendingRequestRef.current
      if (!req) return
      pendingRequestRef.current = null

      const rid = ++requestIdRef.current
      if (workerRef.current) {
        workerRef.current.postMessage({ id: rid, payload: req })
        return
      }
      // Sync fallback: tests, SSR, or Worker init failure.
      const result = computeHealthSync(req)
      setStats(result)
      setReady(true)
    }, HEALTH_DEBOUNCE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  return { stats, ready }
}
