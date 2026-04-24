/// <reference lib="webworker" />

import {
  computeHealthSync, setHealthSyncPerf, consumeHealthSyncPerfBuffer,
  type HealthSyncRequest, type HealthSyncResponse,
} from "./health-worker-sync"

interface WorkerRequest {
  id: number
  payload: HealthSyncRequest
  // Forwarded from the main thread when localStorage.PERF_LOG is on. Workers
  // can't read that themselves, so the caller piggy-backs the flag here and
  // we toggle the worker-side perf logger.
  perf?: boolean
}

interface WorkerResponse {
  id: number
  payload: HealthSyncResponse | { error: string }
  // Perf messages buffered during the worker call; main thread re-emits them
  // via console.log so they show up alongside the main-thread perf logs.
  perfMessages?: string[]
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, payload, perf } = event.data
  if (perf !== undefined) setHealthSyncPerf(perf)
  try {
    const result = computeHealthSync(payload)
    const perfMessages = consumeHealthSyncPerfBuffer()
    const response: WorkerResponse = { id, payload: result, perfMessages }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(self as any).postMessage(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const perfMessages = consumeHealthSyncPerfBuffer()
    const response: WorkerResponse = { id, payload: { error: message }, perfMessages }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(self as any).postMessage(response)
  }
}
