// Typed fetch wrappers for the sync-worker comments read API.
//
// Pattern follows search-read.ts.

import { syncWorkerHttpOrigin } from './sync-worker-url'
import type { CommentRecord, CommentsResponse, FetchCommentsOptions } from './comments-read-types'

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
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<CommentsResponse>(res)
  return body.comments
}

/**
 * GET /api/v1/projects/:projectId/comments
 *
 * Returns all comments across every scope in the project. Used by
 * CommentsPage for the project-wide comments view.
 */
export async function fetchCommentsForProject(
  projectId: string,
  jwt: string,
  opts: FetchCommentsOptions = {},
): Promise<CommentRecord[]> {
  const params = new URLSearchParams()
  if (opts.fileId) params.set('fileId', opts.fileId)
  if (opts.cellId) params.set('cellId', opts.cellId)
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/comments${qs ? `?${qs}` : ''}`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<CommentsResponse>(res)
  return body.comments
}
