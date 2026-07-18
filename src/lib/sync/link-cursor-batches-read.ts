// Typed fetch wrapper for the sync-worker link-cursor-batches read API (AQU-478).
//
//   GET /api/v1/projects/:projectId/link/cursor-batches
//
// Pattern matches `stale-source-read.ts`: sync-token JWT in the
// Authorization header, throws `LinkCursorBatchesError` on non-2xx.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { LinkCursorBatchesResponse } from "./link-cursor-batches-read-types"

export class LinkCursorBatchesError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`link-cursor-batches-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "LinkCursorBatchesError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new LinkCursorBatchesError(res.status, body)
  }
  return (await res.json()) as T
}

/**
 * GET /api/v1/projects/:projectId/link/cursor-batches
 *
 * Returns mirror-sync batches (newest first), each carrying the
 * `source.cell.mirror` / `file.mirror` events it produced — the data the
 * "Upstream changes" review panel groups flagged cells by.
 */
export async function fetchLinkCursorBatches(
  projectId: string,
  jwt: string,
  opts: { limit?: number } = {},
): Promise<LinkCursorBatchesResponse> {
  const params = new URLSearchParams()
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/link/cursor-batches` +
    (qs ? `?${qs}` : "")
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } })
  return readJson<LinkCursorBatchesResponse>(res)
}
