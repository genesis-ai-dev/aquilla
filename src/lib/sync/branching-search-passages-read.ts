// Typed fetch wrapper for the AD-13 passages route.
//
//   GET /api/v1/projects/:projectId/branching-search/passages
//     ?q=<text>[&topK=N][&radius=N][&validatedOnly=true][&excludeCellId=<uuid>]
//
// Same retrieval as `branching-search-read.ts` (flat results); this one
// expands each hit ±radius cells from the same file so the AI batch path
// gets contiguous source/target context for prompt building.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { BranchingSearchPassagesResponse } from "./branching-search-passages-read-types"

export class BranchingSearchPassagesError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(
      `branching-search-passages failed: HTTP ${status} — ${body.slice(0, 200)}`,
    )
    this.status = status
    this.body = body
    this.name = "BranchingSearchPassagesError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new BranchingSearchPassagesError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

export interface BranchingSearchPassagesArgs {
  projectId: string
  query: string
  jwt: string
  topK?: number
  /** Number of context cells before AND after each hit. Server clamps to
   *  [0, 10]; default 2 when omitted. */
  radius?: number
  validatedOnly?: boolean
  excludeCellId?: string
  signal?: AbortSignal
}

export async function fetchBranchingSearchPassages(
  args: BranchingSearchPassagesArgs,
): Promise<BranchingSearchPassagesResponse> {
  const qs = new URLSearchParams()
  qs.set("q", args.query)
  if (args.topK !== undefined) qs.set("topK", String(args.topK))
  if (args.radius !== undefined) qs.set("radius", String(args.radius))
  if (args.validatedOnly) qs.set("validatedOnly", "true")
  if (args.excludeCellId) qs.set("excludeCellId", args.excludeCellId)

  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
    `/branching-search/passages?${qs.toString()}`

  const res = await fetch(url, {
    headers: authHeaders(args.jwt),
    signal: args.signal,
  })
  return readJson<BranchingSearchPassagesResponse>(res)
}
