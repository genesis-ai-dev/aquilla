/// <reference lib="webworker" />

import { computeHealthSync, type HealthSyncRequest, type HealthSyncResponse } from "./health-worker-sync"

interface WorkerRequest {
  id: number
  payload: HealthSyncRequest
}

interface WorkerResponse {
  id: number
  payload: HealthSyncResponse | { error: string }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, payload } = event.data
  try {
    const result = computeHealthSync(payload)
    const response: WorkerResponse = { id, payload: result }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(self as any).postMessage(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const response: WorkerResponse = { id, payload: { error: message } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(self as any).postMessage(response)
  }
}
