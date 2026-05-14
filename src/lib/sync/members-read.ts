// Typed fetch wrapper for frontier-server project members read API (Phase 2b).
//
// Strict-failure counterpart to `frontier/members.ts.listProjectMembers`,
// which returns null on 403/404 to support local-only projects on the
// dashboard. The hook variant rejects with `MembersReadError` so callers
// can distinguish "no access" from a fetch error.

import { AUTH_API_URL } from "./sync-token"
import type {
  ProjectMember,
  ProjectMembersResponse,
} from "./members-read-types"

export class MembersReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`members-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "MembersReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new MembersReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

/**
 * GET /api/v2/projects/:projectId/members.
 *
 * Resolves to the effective member list — explicit project_members rows
 * plus org_members grants plus the creator. The server resolves the
 * highest-priority role per user.
 */
export async function fetchProjectMembers(
  projectId: string,
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<ProjectMember[]> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    { headers: authHeaders(jwt) },
  )
  const body = await readJson<ProjectMembersResponse>(res)
  return body.members
}
