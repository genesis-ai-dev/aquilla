// Typed fetch wrapper for the sync-worker per-cell history read API.
//
// Pattern follows `cells-read.ts` (Phase 2a): caller passes a sync-token
// JWT scoped to the same project; failures throw `HistoryReadError` with
// the HTTP status + body.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { CellHistoryEvent, CellHistoryResponse } from "./history-read-types"

export class HistoryReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`history-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "HistoryReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new HistoryReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
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
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<CellHistoryResponse>(res)
  return body.events
}
