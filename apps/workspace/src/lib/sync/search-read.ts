// Typed fetch wrapper for the sync-worker project-wide search API.
//
// Pattern follows `cells-read.ts` (Phase 2a). Server runs FTS5 against the
// `cells.value` virtual table, scoped to (projectId, optional side).

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type {
  FetchSearchOptions,
  SearchResponse,
  SearchResult,
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
 * GET /api/v1/projects/:projectId/search?q=&side=&limit=
 *
 * Returns FTS5-ranked search results across every file in the project.
 * The query is sanitized server-side before being passed to FTS5 — callers
 * pass raw user input; bare punctuation, FTS reserved words, etc. are
 * stripped before MATCH.
 *
 * Returns `[]` for an empty query, an all-punctuation query, or any other
 * input that sanitizes to zero tokens (the server returns `{results: []}`
 * with HTTP 200 in those cases).
 */
export async function fetchProjectSearch(
  projectId: string,
  q: string,
  opts: FetchSearchOptions,
  jwt: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams()
  params.set("q", q)
  if (opts.side) params.set("side", opts.side)
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/search?${params.toString()}`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<SearchResponse>(res)
  return body.results
}
