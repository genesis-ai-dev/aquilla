// Typed fetch wrapper for the sync-worker AD-14 health-as-confidence route.
//
//   GET /api/v1/projects/:projectId/cell-confidence?cellIds=a,b,c[&topK=N]
//
// Returns a per-cell confidence in [0, 1] — "does this look like a translation
// that ought to be validated?" — derived on read from FTS5 similarity to the
// project's validated cells. Pass a viewport-sized batch of cellIds, never a
// whole file (cost is one FTS5 MATCH per unvalidated cell).

import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface CellConfidenceDetail {
  validated: boolean
  neighbors: number
  topCellId: string | null
}

export interface CellConfidenceResponse {
  confidence: Record<string, number>
  detail: Record<string, CellConfidenceDetail>
  tookMs: number
}

export class CellConfidenceError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`cell-confidence failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "CellConfidenceError"
  }
}

export interface CellConfidenceArgs {
  projectId: string
  fileId: string
  cellIds: string[]
  jwt: string
  topK?: number
  /** Per-hop authority decay (project-tunable). Server default 0.8. */
  perHopDecay?: number
  signal?: AbortSignal
}

export async function fetchCellConfidence(
  args: CellConfidenceArgs,
): Promise<CellConfidenceResponse> {
  const qs = new URLSearchParams()
  qs.set("fileId", args.fileId)
  qs.set("cellIds", args.cellIds.join(","))
  if (args.topK !== undefined) qs.set("topK", String(args.topK))
  if (args.perHopDecay !== undefined) qs.set("perHopDecay", String(args.perHopDecay))

  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
    `/cell-confidence?${qs.toString()}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${args.jwt}` },
    signal: args.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new CellConfidenceError(res.status, body)
  }
  return (await res.json()) as CellConfidenceResponse
}
