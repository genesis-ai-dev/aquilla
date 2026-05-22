// Typed fetch wrapper for the sync-worker AD-13 branching-search route.
//
//   GET /api/v1/projects/:projectId/branching-search
//     ?q=<text>[&topK=N][&validatedOnly=true][&excludeCellId=<uuid>]
//
// Returns the deterministic top-K cells the spec algorithm picked, plus a
// provenance map of which contiguous sub-query each result satisfied. Used
// by the AI copilot's few-shot retrieval (replaces the client-side
// `@/lib/search/dual-index` search). AD-14 decay endorsement will use the
// same primitive when it lands.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { BranchingSearchResponse } from "./branching-search-read-types"

export class BranchingSearchError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`branching-search failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "BranchingSearchError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new BranchingSearchError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

export interface BranchingSearchArgs {
  projectId: string
  query: string
  jwt: string
  /** Override the server's default topK. Server caps at MAX_TOP_K (50). */
  topK?: number
  /** Restrict the corpus to cells with a validated target. */
  validatedOnly?: boolean
  /** Exclude this cellId from the corpus (e.g., the cell the copilot is
   *  completing — we never want it to retrieve itself). */
  excludeCellId?: string
  /** Optional AbortSignal so cancelling a completion cancels the fetch. */
  signal?: AbortSignal
}

/**
 * Runs the AD-13 branching search against the server's corpus. Throws
 * `BranchingSearchError` on non-2xx; otherwise resolves to the response.
 */
export async function fetchBranchingSearch(
  args: BranchingSearchArgs,
): Promise<BranchingSearchResponse> {
  const qs = new URLSearchParams()
  qs.set("q", args.query)
  if (args.topK !== undefined) qs.set("topK", String(args.topK))
  if (args.validatedOnly) qs.set("validatedOnly", "true")
  if (args.excludeCellId) qs.set("excludeCellId", args.excludeCellId)

  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
    `/branching-search?${qs.toString()}`

  const res = await fetch(url, {
    headers: authHeaders(args.jwt),
    signal: args.signal,
  })
  return readJson<BranchingSearchResponse>(res)
}
