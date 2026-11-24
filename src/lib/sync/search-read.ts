// Typed fetch wrapper for the sync-worker project-wide search API.
//
// Pattern follows `cells-read.ts` (Phase 2a). Server runs FTS5 against the
// `cells.value` virtual table, scoped to (projectId, optional side).

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type {
  FetchSearchOptions,
  FetchParallelPassagesOptions,
  ParallelPassageResult,
  ParallelPassagesResponse,
  SearchPage,
  SearchResponse,
} from "./search-read-types"

export class SearchReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`search-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "SearchReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new SearchReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

/**
 * The page a response describes. A sync-worker that predates `total` sends
 * only the rows, and the rows are then all that is known to have matched.
 */
function pageOf<Row>(
  results: Row[],
  body: { total?: number; totalIsLowerBound?: boolean },
): SearchPage<Row> {
  const total = typeof body.total === "number" && Number.isFinite(body.total) ? body.total : results.length
  return {
    results,
    total: Math.max(total, results.length),
    totalIsLowerBound: body.totalIsLowerBound === true,
  }
}

/**
 * GET /api/v1/projects/:projectId/search?q=&side=&limit=&fileId=
 *
 * Returns FTS5-ranked search results across every file in the project, or
 * within `opts.fileId` when given.
 * The query is sanitized server-side before being passed to FTS5 — callers
 * pass raw user input; bare punctuation, FTS reserved words, etc. are
 * stripped before MATCH.
 *
 * Returns an empty page for an empty query, an all-punctuation query, or any
 * other input that sanitizes to zero tokens (the server answers those with
 * HTTP 200 and no results).
 *
 * `results` is cut at `opts.limit`; `total` is how many matched before the
 * cut, so a caller can say "50 of 596" (AQU-2732).
 */
export async function fetchProjectSearch(
  projectId: string,
  q: string,
  opts: FetchSearchOptions,
  jwt: string,
): Promise<SearchPage> {
  const params = new URLSearchParams()
  params.set("q", q)
  if (opts.side) params.set("side", opts.side)
  if (opts.fileId) params.set("fileId", opts.fileId)
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  if (opts.matchCase) params.set("case", "1")
  if (opts.wholeWord) params.set("word", "1")
  if (opts.useRegexp) params.set("regexp", "1")
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/search?${params.toString()}`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<SearchResponse>(res)
  return pageOf(body.results, body)
}

/**
 * GET /api/v1/projects/:projectId/search/passages?q=&side=&limit=
 *
 * Returns FTS5-ranked results that also include the paired-side cell value
 * at the same (fileId, cellId). The `projectId` field is stitched on by
 * the client after the fetch — the server URL already carries that context.
 */
export async function fetchProjectParallelPassages(
  projectId: string,
  q: string,
  opts: FetchParallelPassagesOptions,
  jwt: string,
): Promise<SearchPage<ParallelPassageResult>> {
  const params = new URLSearchParams()
  params.set("q", q)
  if (opts.side) params.set("side", opts.side)
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/search/passages?${params.toString()}`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<ParallelPassagesResponse>(res)
  return pageOf(body.results.map((r) => ({ ...r, projectId })), body)
}

/**
 * Multi-project fan-out: calls `fetchProjectParallelPassages` for every
 * projectId via `Promise.all` and flattens the results. Skips projects
 * where `getToken` returns null (no access). Per-project failures are
 * caught and warned — a single bad project does not poison the whole fan-out.
 *
 * `limit` is per project, so the total is the sum of each project's.
 */
export async function fetchParallelPassages(
  q: string,
  opts: { projectIds: string[]; side?: "source" | "target"; limit?: number },
  getToken: (projectId: string) => Promise<string | null>,
): Promise<SearchPage<ParallelPassageResult>> {
  const none: SearchPage<ParallelPassageResult> = { results: [], total: 0, totalIsLowerBound: false }

  const perProject = opts.projectIds.map(async (projectId) => {
    try {
      const token = await getToken(projectId)
      if (!token) return none
      return await fetchProjectParallelPassages(
        projectId,
        q,
        { side: opts.side, limit: opts.limit },
        token,
      )
    } catch (err) {
      console.warn(`[fetchParallelPassages] fetch failed for project ${projectId}:`, err)
      return none
    }
  })

  const settled = await Promise.all(perProject)
  return {
    results: settled.flatMap((page) => page.results),
    total: settled.reduce((sum, page) => sum + page.total, 0),
    totalIsLowerBound: settled.some((page) => page.totalIsLowerBound),
  }
}
