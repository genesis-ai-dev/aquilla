// Client fetch wrapper for the AD-14 health-rollup route.
//
//   GET /api/v1/projects/:projectId/health-rollup[?fileId=F][&maxHops=N][&perHopDecay=0.8]
//
// Returns confidence-derived health (0-100) for a project and per-file.
// Health = mean(confidence) over all translated cells in scope; untranslated
// cells are excluded. Confidence ripples from validated anchors (= 100) through
// the example-retrieval graph using the AD-14 propagation algorithm.

import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface HealthRollupResponse {
  /** Overall project health 0-100 = mean(confidence over translated cells). */
  projectHealth: number
  /** fileId → file health 0-100. Absent when a fileId filter was given and returned nothing. */
  fileHealth: Record<string, number>
  /** Total translated cells included in the rollup. */
  totalCells: number
  tookMs: number
}

export class HealthRollupError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`health-rollup failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "HealthRollupError"
  }
}

export interface HealthRollupArgs {
  projectId: string
  jwt: string
  /** Optional: restrict rollup to a single file. */
  fileId?: string
  /** Per-hop authority decay. Server default 0.8. */
  perHopDecay?: number
  /**
   * AD-14: max propagation radius from validated anchors. Project-tunable.
   * Server default 4.
   */
  maxHops?: number
  signal?: AbortSignal
}

export async function fetchHealthRollup(args: HealthRollupArgs): Promise<HealthRollupResponse> {
  const qs = new URLSearchParams()
  if (args.fileId) qs.set("fileId", args.fileId)
  if (args.perHopDecay !== undefined) qs.set("perHopDecay", String(args.perHopDecay))
  if (args.maxHops !== undefined) qs.set("maxHops", String(args.maxHops))

  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
    `/health-rollup?${qs.toString()}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${args.jwt}` },
    signal: args.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new HealthRollupError(res.status, body)
  }
  return (await res.json()) as HealthRollupResponse
}
