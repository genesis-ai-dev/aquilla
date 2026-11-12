// Typed fetch wrapper for the sync-worker per-cell history read API.
//
// Pattern follows `cells-read.ts` (Phase 2a; AQU-775 / RES-6): caller passes
// a sync-token JWT scoped to the same project; each attempt carries a hard
// timeout, transient failures are retried a bounded number of times, and the
// final failure throws `HistoryReadError` saying whether the network or the
// server failed.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { timeoutSignal } from "./fetch-timeout"
import { observedSyncFetch, readSyncJson } from "./connection-activity"
import { isTransientReadStatus, isTransportFailure, retryTransientRead } from "./read-retry"
import type { CellHistoryEvent, CellHistoryResponse } from "./history-read-types"

/** AQU-1248: what the user is told when every attempt failed.
 *  - `network` — no response arrived: transport/CORS failure, timeout, or
 *    the sync worker unreachable. `status` is 0.
 *  - `server` — the sync worker answered with an error status. */
export type HistoryReadFailureKind = "network" | "server"

export class HistoryReadError extends Error {
  /** HTTP status, or 0 when no response arrived. */
  status: number
  body: string
  kind: HistoryReadFailureKind
  constructor(status: number, body: string, options?: ErrorOptions) {
    const kind: HistoryReadFailureKind = status === 0 ? "network" : "server"
    super(
      kind === "network"
        ? `history-read failed: network — ${body.slice(0, 200)}`
        : `history-read failed: HTTP ${status} — ${body.slice(0, 200)}`,
      options,
    )
    this.status = status
    this.body = body
    this.kind = kind
    this.name = "HistoryReadError"
  }
}

// Same per-attempt ceiling as cells-read: a hung request must not hold the
// drawer on "Loading history…" until the browser's own socket timeout.
const HISTORY_READ_TIMEOUT_MS = 15_000

// AQU-1248: three attempts, like cells-read, but a longer backoff. The drawer
// is a wait-and-watch surface (a reviewer opens it and waits for their edit
// to appear), and on a lossy link a burst of dropped packets outlasts
// cells-read's 100/400 ms, which would spend every attempt inside half a
// second. Spreading them over ~2.5 s rides out a short outage while a
// worker that is really down still reports within a few seconds.
const HISTORY_READ_RETRY_DELAYS_MS = [500, 2_000] as const

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new HistoryReadError(res.status, body)
  }
  return readSyncJson<T>(res)
}

function isTransientHistoryReadError(error: unknown): boolean {
  if (error instanceof HistoryReadError) return isTransientReadStatus(error.status)
  return isTransportFailure(error)
}

function authHeaders(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}` }
}

/**
 * GET /api/v1/projects/:projectId/files/:fileId/cells/:cellId/history
 *
 * Returns the events on this cell's chain, newest first. Server clamps the
 * `limit` parameter to [1, 200]; the default is 50.
 */
export async function fetchCellHistory(
  projectId: string,
  fileId: string,
  cellId: string,
  jwt: string,
  opts: { limit?: number } = {},
): Promise<CellHistoryEvent[]> {
  const params = new URLSearchParams()
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/cells/${encodeURIComponent(cellId)}/history` +
    (qs ? `?${qs}` : "")
  try {
    const body = await retryTransientRead(
      async () => readJson<CellHistoryResponse>(await observedSyncFetch(url, {
        headers: authHeaders(jwt),
        signal: timeoutSignal(HISTORY_READ_TIMEOUT_MS),
      })),
      isTransientHistoryReadError,
      HISTORY_READ_RETRY_DELAYS_MS,
    )
    return body.events
  } catch (error) {
    if (isTransportFailure(error)) {
      throw new HistoryReadError(0, error instanceof Error ? error.message : String(error), { cause: error })
    }
    throw error
  }
}
