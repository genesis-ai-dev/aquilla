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
import { timeoutSignal } from "./fetch-timeout"
import type { CellRow, CellsPage, FileSummary } from "./cells-read-types"
// Re-export so consumers (e.g. org/ProjectOverview) can import FileSummary from
// the read-API module rather than reaching into cells-read-types directly.
export type { FileSummary } from "./cells-read-types"

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

function authHeaders(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}` }
}

// The server stores `cells.metadata` as JSONB and normally returns it parsed
// (an object). Defensively handle the case where a row arrives with `metadata`
// still serialized as a JSON string (e.g. a projection path that didn't parse
// the column): parse it through to an object so consumers see a uniform shape.
// A non-string, non-object value (or unparsable string) is coerced to null so
// the field never carries a surprise primitive downstream.
function normalizeRowMetadata(row: CellRow): CellRow {
  const m = row.metadata as unknown
  if (m == null) return row
  if (typeof m === "string") {
    try {
      const parsed = JSON.parse(m) as unknown
      return { ...row, metadata: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null }
    } catch {
      return { ...row, metadata: null }
    }
  }
  if (typeof m === "object") return row
  return { ...row, metadata: null }
}

function normalizeRowsMetadata(rows: CellRow[]): CellRow[] {
  return rows.map(normalizeRowMetadata)
}

// RES-6: a hung connection must not strand the editor skeleton until the
// browser's multi-minute socket timeout — soft refetches are dropped while a
// fetch is in flight, so one wedged request blocks every later trigger. A
// timeout rejects like a network error: callers keep the cached view and the
// next trigger (focus, WS poke) retries. `timeoutSignal` is the shared
// older-WebKit guard (see fetch-timeout.ts) used by reads and writes alike.
const READ_TIMEOUT_MS = 15_000

function fetchInit(jwt: string): RequestInit {
  return { headers: authHeaders(jwt), signal: timeoutSignal(READ_TIMEOUT_MS) }
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
  const res = await fetch(url, fetchInit(jwt))
  const body = await readJson<{ files: FileSummary[] }>(res)
  return body.files
}

/**
 * GET /api/v1/projects/:projectId/files?trash=1
 *
 * Returns soft-deleted (tombstoned) files for the "Recently deleted" trash UI.
 * Requires PROJECT_LEAD+ role (same as file.delete/file.restore events).
 */
export async function fetchDeletedFiles(
  projectId: string,
  jwt: string,
): Promise<FileSummary[]> {
  const url = `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/files?trash=1`
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
  const res = await fetch(url, fetchInit(jwt))
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

/** Full-read page plus the M2-1 watermark. Extends the shared `CellsPage`
 *  locally (cells-read-types is owned elsewhere this wave); `maxServerSeq`
 *  is absent when talking to a pre-M2-1 server. */
export interface CellsPageWithMeta extends CellsPage {
  maxServerSeq?: number | null
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
): Promise<CellsPageWithMeta> {
  const params = new URLSearchParams()
  if (opts.side) params.set("side", opts.side)
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  if (opts.cursor) params.set("cursor", opts.cursor)
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/cells` +
    (qs ? `?${qs}` : "")
  const res = await fetch(url, fetchInit(jwt))
  const page = await readJson<CellsPageWithMeta>(res)
  return { ...page, cells: normalizeRowsMetadata(page.cells) }
}

/** Outcome of a `?since=` conditional read (audit M2-1). */
export type CellsDeltaResult =
  /** Changed cells since the cursor. A `changedCellIds` entry with no row in
   *  `cells` was deleted. Empty arrays = nothing changed (the cheap common
   *  case for focus revalidation). */
  | { kind: "delta"; changedCellIds: string[]; cells: CellRow[]; maxServerSeq: number }
  /** Server says the delta is bigger than a full read is worth — or this is
   *  a pre-M2-1 server that ignored `since` (no `delta` marker in the body).
   *  Caller falls back to the full stream. */
  | { kind: "resync" }

/**
 * One conditional request against the cells read route: `?since=<serverSeq>`.
 *
 * Deliberately NOT using `If-None-Match`: the sync-worker's CORS allowlist
 * (`Access-Control-Allow-Headers` in sync-worker/src/cors.ts) doesn't cover
 * it, and an empty delta response answers "nothing changed" just as cheaply
 * (one indexed seq-range probe) without a preflight-breaking header.
 */
export async function fetchCellsDelta(
  projectId: string,
  fileId: string,
  since: number,
  jwt: string,
): Promise<CellsDeltaResult> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/cells?since=${encodeURIComponent(String(since))}`
  const res = await fetch(url, fetchInit(jwt))
  const body = await readJson<{
    delta?: boolean
    resync?: boolean
    changedCellIds?: string[]
    cells?: CellRow[]
    maxServerSeq?: number
  }>(res)
  if (body.delta === true && typeof body.maxServerSeq === "number") {
    return {
      kind: "delta",
      changedCellIds: body.changedCellIds ?? [],
      cells: normalizeRowsMetadata(body.cells ?? []),
      maxServerSeq: body.maxServerSeq,
    }
  }
  return { kind: "resync" }
}

/**
 * Targeted read: fetch a small set of cells by id without paying for the
 * anchor-chain walk. Used by the WS-triggered single-cell revalidate path
 * so a remote validate/commit doesn't refetch the whole file. Returns both
 * sides of each requested cellId (one source row + one target row, if both
 * exist in the projection). Server caps the list at 100.
 */
export async function fetchCellsByIds(
  projectId: string,
  fileId: string,
  cellIds: string[],
  jwt: string,
): Promise<CellRow[]> {
  if (cellIds.length === 0) return []
  const params = new URLSearchParams()
  params.set("cellIds", cellIds.join(","))
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/cells?${params.toString()}`
  const res = await fetch(url, fetchInit(jwt))
  const page = await readJson<CellsPage>(res)
  return normalizeRowsMetadata(page.cells)
}

/**
 * Stream every page of cells for a file. Invokes `onPage(rows, isLast)` after
 * each successful page fetch so the caller can render incrementally instead
 * of waiting for the whole file. Pages arrive in server order: source rows in
 * anchor-chain order first, then target rows in anchor-chain order.
 *
 * `onPage` may return `false` (or a Promise resolving to `false`) to abort
 * pagination — typically because the caller switched files mid-stream and
 * the in-flight result is no longer wanted.
 *
 * `onMeta` (optional) fires once per page, BEFORE that page's `onPage`, with
 * the page's `maxServerSeq`. The FIRST page's watermark is the safe `?since=`
 * cursor for the stream: anything that lands mid-stream has a higher seq, so
 * the next delta re-fetches it. A page-to-page difference means events landed
 * mid-stream — and because the server paginates by offset, a row that shifted
 * across a page boundary may have been skipped entirely (a torn snapshot), so
 * callers must NOT mint a `?since=` cursor from such a stream (audit B2).
 */
export async function streamFileCells(
  projectId: string,
  fileId: string,
  jwt: string,
  onPage: (rows: CellRow[], isLast: boolean) => boolean | void | Promise<boolean | void>,
  side?: "source" | "target",
  onMeta?: (meta: { maxServerSeq?: number | null }) => void,
): Promise<void> {
  let cursor: string | undefined
  // Hard cap on page iterations as a safety belt against a malformed nextCursor
  // loop. At max page size (2000) this allows up to 200k cells per file.
  const MAX_PAGES = 100
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchFileCells(projectId, fileId, { side, cursor }, jwt)
    if (onMeta) onMeta({ maxServerSeq: page.maxServerSeq })
    const nextCursor = page.nextCursor ?? undefined
    const isLast = nextCursor === undefined
    const cont = await onPage(page.cells, isLast)
    if (cont === false) return
    if (isLast) return
    cursor = nextCursor
  }
  throw new CellsReadError(0, `pagination exceeded ${MAX_PAGES} pages for fileId=${fileId}`)
}

/**
 * Paginate through every page of cells for a file. Returns the flat array of
 * `CellRow`s in anchor-chain order. Convenience wrapper over
 * `streamFileCells` for callers that only need the final result (tests,
 * non-UI consumers). The editor read path uses `streamFileCells` directly so
 * the first page paints before the bible-sized tail is in.
 */
export async function fetchAllFileCells(
  projectId: string,
  fileId: string,
  jwt: string,
  side?: "source" | "target",
): Promise<CellRow[]> {
  const out: CellRow[] = []
  await streamFileCells(
    projectId,
    fileId,
    jwt,
    (rows) => {
      out.push(...rows)
    },
    side,
  )
  return out
}
