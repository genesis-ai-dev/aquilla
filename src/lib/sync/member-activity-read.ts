// Typed fetch wrapper for the sync-worker per-member activity read API
// (AQU-498). Pattern follows `history-read.ts`: caller passes a sync-token
// JWT scoped to the same project; failures throw `MemberActivityReadError`
// with the HTTP status + body.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { MemberActivityResponse } from "./member-activity-read-types"

export class MemberActivityReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`member-activity-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "MemberActivityReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new MemberActivityReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

/**
 * GET /api/v1/projects/:projectId/members/:author/activity
 *
 * `author` is the member's Aquilla username (events.author / cells.last_editor),
 * not a numeric user id. Server clamps `limit` to [1, 200]; default 50.
 */
export async function fetchMemberActivity(
  projectId: string,
  author: string,
  jwt: string,
  opts: { limit?: number } = {},
): Promise<MemberActivityResponse> {
  const params = new URLSearchParams()
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/members/${encodeURIComponent(author)}/activity` +
    (qs ? `?${qs}` : "")
  const res = await fetch(url, { headers: authHeaders(jwt) })
  return readJson<MemberActivityResponse>(res)
}
