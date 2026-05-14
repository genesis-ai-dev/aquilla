// Typed fetch wrappers for the sync-worker read API (Phase 2a; AD-3 v1).
//
// Callers pass an already-minted sync-token JWT scoped to the same project;
// see `makeSyncTokenFetcher` in `sync-token.ts` for how to obtain one. The
// token's `projectId` claim must equal the path's :projectId, else the
// server returns 403.
//
// Failure model: rejects with `CellsReadError` carrying the HTTP status and
// the response body (truncated). Callers decide whether to surface as a
// retry-able transient error (5xx) or as an auth problem (401/403).

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { CellRow, CellsPage, FileSummary } from "./cells-read-types"

export class CellsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`cells-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "CellsReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new CellsReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

/**
 * GET /api/v1/projects/:projectId/files
 *
 * Returns every file in the project, ordered by recency (most-recent first).
 * Counters are projected from the event log — never out of date by more than
 * an onSave debounce window (~2s).
 */
export async function fetchProjectFiles(
  projectId: string,
  jwt: string,
): Promise<FileSummary[]> {
  const url = `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/files`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<{ files: FileSummary[] }>(res)
  return body.files
}

/**
 * GET /api/v1/projects/:projectId/files/:fileId
 *
 * One file's rollup row. 404 surfaces as `CellsReadError` with status 404.
 */
export async function fetchFile(
  projectId: string,
  fileId: string,
  jwt: string,
): Promise<FileSummary> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<{ file: FileSummary }>(res)
  return body.file
}

export interface FetchFileCellsOptions {
  /** Restrict to a single side. Omit to fetch both source and target rows
   *  — the default for the editor table which renders them paired. */
  side?: "source" | "target"
  /** Page size. Server clamps to [1, 2000]; default 500. */
  limit?: number
  /** Resume cursor from a previous page. */
  cursor?: string
}

/**
 * GET /api/v1/projects/:projectId/files/:fileId/cells
 *
 * Returns one page of cells in anchor-chain order. Source rows appear before
 * target rows in the combined response when `side` is omitted.
 */
export async function fetchFileCells(
  projectId: string,
  fileId: string,
  opts: FetchFileCellsOptions,
  jwt: string,
): Promise<CellsPage> {
  const params = new URLSearchParams()
  if (opts.side) params.set("side", opts.side)
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  if (opts.cursor) params.set("cursor", opts.cursor)
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/cells` +
    (qs ? `?${qs}` : "")
  const res = await fetch(url, { headers: authHeaders(jwt) })
  return await readJson<CellsPage>(res)
}

/**
 * Paginate through every page of cells for a file. Returns the flat array of
 * `CellRow`s in anchor-chain order. Calls `fetchFileCells` repeatedly until
 * `nextCursor` is null.
 *
 * Convenience for the v1 hook — pages are still individually small enough to
 * stream into a single state update, so we don't expose the page stream
 * externally. Bible-sized files (~30k cells) take ~3-5 round trips at the
 * default page size; future tier 2 caching will eliminate this.
 */
export async function fetchAllFileCells(
  projectId: string,
  fileId: string,
  jwt: string,
  side?: "source" | "target",
): Promise<CellRow[]> {
  const out: CellRow[] = []
  let cursor: string | undefined
  // Hard cap on page iterations as a safety belt against a malformed nextCursor
  // loop. At max page size (2000) this allows up to 200k cells per file.
  const MAX_PAGES = 100
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchFileCells(projectId, fileId, { side, cursor }, jwt)
    out.push(...page.cells)
    if (!page.nextCursor) return out
    cursor = page.nextCursor
  }
  throw new CellsReadError(0, `pagination exceeded ${MAX_PAGES} pages for fileId=${fileId}`)
}
