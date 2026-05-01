import { useEffect, useRef, useState } from "react"
import { computeHealthSync, type HealthSyncCell, type HealthSyncRequest, type HealthSyncResponse } from "@/workers/health-worker-sync"
import type { CellData } from "./useCells"
import type { HealthConfig, TranslationRule } from "@/lib/parsers/types"
import { perfLog, perfMark, isPerfLogEnabled } from "@/lib/perf-log"
import { setHealthSyncPerf } from "@/workers/health-worker-sync"

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

  // Worker setup + teardown runs once. A single persistent message listener
  // dispatches responses by request id so we don't leak listeners across the
  // many recomputes a long-lived editor session triggers.
  useEffect(() => {
    if (!isTestEnv && typeof Worker !== "undefined") {
      try {
        const w = createHealthWorker()
        w.onmessage = (event: MessageEvent<{ id: number; payload: HealthSyncResponse | { error: string }; perfMessages?: string[] }>) => {
          // Worker-side perf messages are shipped here for main-thread re-emit
          // (worker console.log isn't visible to many DevTools consumers).
          if (event.data.perfMessages && event.data.perfMessages.length > 0) {
            for (const m of event.data.perfMessages) {
              // eslint-disable-next-line no-console
              console.log(m)
            }
          }
          if (event.data.id !== requestIdRef.current) return
          const p = event.data.payload
          if ("error" in p) {
            console.error("[useCompositeHealth] worker error:", p.error)
            return
          }
          perfLog(`health.worker.recv id=${event.data.id} cells=${p.healthMap.size} infractions=${p.infractions.size}`)
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

  // Latest inputs captured in a ref so the debounced callback always reads
  // the freshest values without re-allocating cells on every render. The
  // effect body only schedules — all heavy work (buildCells + JSON key +
  // postMessage) happens inside the timer.
  const latestInputRef = useRef(input)
  latestInputRef.current = input

  // Schedule a recompute when an input identity actually changes. The deps
  // are the four input fields (each stable across renders by upstream useMemo
  // / primitive). Without these deps the effect would fire on every parent
  // render — any unrelated state churn (video time, presence, sync ticks)
  // would reset the timer and a validate/invalidate could go unrecomputed
  // until renders happen to quiesce for a full debounce window.
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      const endTotal = perfMark("health.debounce.fire total")
      const current = latestInputRef.current
      const endBuild = perfMark("health.buildCells")
      const cells = buildCells(current.fileCells)
      endBuild()
      perfLog(`health.debounce.fire cells=${cells.length} rules=${current.rules.length}`)

      // Cheap content key so we bail out when a new Map/array is passed with
      // identical content (avoids re-firing the worker for no-op updates).
      const key = JSON.stringify([
        cells.map(c => [
          c.id,
          c.translated,
          c.validatorCount,
          c.history.length,
          c.history.at(-1)?.examples,
        ]),
        current.requiredValidations,
        current.rules,
        current.config,
      ])
      if (key === prevKeyRef.current) return
      prevKeyRef.current = key

      const req: HealthSyncRequest = {
        cells,
        rules: current.rules,
        config: current.config,
        requiredValidations: current.requiredValidations,
      }

      const rid = ++requestIdRef.current
      const perf = isPerfLogEnabled()
      if (workerRef.current) {
        perfLog(`health.worker.post id=${rid} cells=${req.cells.length}`)
        workerRef.current.postMessage({ id: rid, payload: req, perf })
        endTotal()
        return
      }
      // Sync fallback: tests, SSR, or Worker init failure.
      setHealthSyncPerf(perf)
      const endSync = perfMark("health.sync.compute")
      const result = computeHealthSync(req)
      endSync()
      setStats(result)
      setReady(true)
      endTotal()
    }, HEALTH_DEBOUNCE_MS)
  }, [input.fileCells, input.rules, input.config, input.requiredValidations])

  return { stats, ready }
}
