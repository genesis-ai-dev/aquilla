// Typed fetch wrappers for the sync-worker comments read API.
//
// Pattern follows search-read.ts.

import { syncWorkerHttpOrigin } from './sync-worker-url'
import { timeoutSignal } from './fetch-timeout'
import type { CommentCounts, CommentRecord, CommentsResponse, FetchCommentsOptions } from './comments-read-types'

export class CommentsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`comments-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = 'CommentsReadError'
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CommentsReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

// AQU-1275: this path had no timeout at all, so a connection that hung (the
// reported case was a VPN dropping one page request mid-flight) wedged the
// whole project-wide refresh until the browser's multi-minute socket timeout.
// The caller kept the rows it already had and the drawer rendered them as
// "No comments yet" — a partial load that reads as deleted data. Same contract
// as cells-read.ts: a hard timeout plus a bounded retry of the errors that can
// recover on their own; deterministic 4xx still fails immediately.
const COMMENTS_READ_TIMEOUT_MS = 15_000
const COMMENTS_READ_ATTEMPTS = 3
const COMMENTS_READ_RETRY_DELAYS_MS = [100, 400] as const

function fetchInit(jwt: string): RequestInit {
  return { headers: authHeaders(jwt), signal: timeoutSignal(COMMENTS_READ_TIMEOUT_MS) }
}

function isTransientCommentsReadError(error: unknown): boolean {
  if (error instanceof CommentsReadError) {
    return error.status === 408
      || error.status === 425
      || error.status === 429
      || error.status >= 500
  }
  // Browser fetch rejects with TypeError for transport and CORS failures.
  // AbortError/TimeoutError are the timeoutSignal watchdog firing.
  return error instanceof TypeError
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}

async function fetchCommentsJson<T>(url: string, jwt: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < COMMENTS_READ_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, fetchInit(jwt))
      return await readJson<T>(res)
    } catch (error) {
      lastError = error
      if (!isTransientCommentsReadError(error) || attempt === COMMENTS_READ_ATTEMPTS - 1) {
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, COMMENTS_READ_RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastError
}

/**
 * GET /api/v1/projects/:projectId/comments?fileId=&cellId=
 *
 * Returns all comments for the project, optionally filtered to a specific
 * cell (when both fileId and cellId are provided) or file (fileId only).
 *
 * Results are ordered by createdAt ASC (oldest first, natural reading order).
 */
export async function fetchCommentsForCell(
  projectId: string,
  fileId: string,
  cellId: string,
  jwt: string,
): Promise<CommentRecord[]> {
  const params = new URLSearchParams()
  params.set('fileId', fileId)
  params.set('cellId', cellId)
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/comments?${params.toString()}`
  const body = await fetchCommentsJson<CommentsResponse>(url, jwt)
  return body.comments
}

/**
 * GET /api/v1/projects/:projectId/comments?fileId=&cellId=&limit=&cursor=
 *
 * One page of comments (worker default 200 rows) in createdAt ASC order plus
 * the cursor for the next page. Feed `nextCursor` back as `cursor` until it
 * comes back null.
 */
export async function fetchCommentsPage(
  projectId: string,
  jwt: string,
  opts: FetchCommentsOptions = {},
): Promise<{ comments: CommentRecord[]; nextCursor: string | null }> {
  const params = new URLSearchParams()
  if (opts.fileId) params.set('fileId', opts.fileId)
  if (opts.cellId) params.set('cellId', opts.cellId)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.cursor) params.set('cursor', opts.cursor)
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/comments${qs ? `?${qs}` : ''}`
  const body = await fetchCommentsJson<CommentsResponse>(url, jwt)
  return { comments: body.comments, nextCursor: body.nextCursor ?? null }
}

/**
 * Every comment matching the scope, following `nextCursor` to the end.
 * `onPage` fires after each page lands with the rows so far, so a caller can
 * render the first page before the rest arrives.
 */
export async function fetchCommentsForProject(
  projectId: string,
  jwt: string,
  opts: FetchCommentsOptions = {},
  onPage?: (soFar: CommentRecord[]) => void,
): Promise<CommentRecord[]> {
  const all: CommentRecord[] = []
  let cursor: string | undefined = opts.cursor
  do {
    const page = await fetchCommentsPage(projectId, jwt, { ...opts, cursor })
    all.push(...page.comments)
    onPage?.(all)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return all
}

/**
 * GET /api/v1/projects/:projectId/comments/counts
 *
 * Open-thread counts for badges — an indexed GROUP BY on the worker, no rows.
 */
export async function fetchCommentCounts(projectId: string, jwt: string): Promise<CommentCounts> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/comments/counts`
  return fetchCommentsJson<CommentCounts>(url, jwt)
}
