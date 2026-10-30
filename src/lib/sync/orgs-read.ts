// Typed fetch wrappers for auth-worker orgs endpoints (Phase 2b).
//
// Wraps the legacy `frontier/orgs.ts` primitives in the Phase 2a strict-
// failure pattern: throws `OrgsReadError` on any non-2xx so the hook layer
// can surface error state explicitly.

import { AUTH_API_URL } from "./sync-token"
import type {
  MyOrg,
  OrgMember,
  OrgMembersResponse,
} from "./orgs-read-types"

export class OrgsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`orgs-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "OrgsReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new OrgsReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

/**
 * GET /api/v2/orgs/me — the caller's own personal workspace, or null when they
 * own none (AQU-2259: the read no longer creates one).
 */
export async function fetchUserOrgs(
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<MyOrg | null> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/me`, {
    headers: authHeaders(jwt),
  })
  if (res.status === 404) return null
  return await readJson<MyOrg>(res)
}

/**
 * GET /api/v2/orgs/:orgId/members — member roster scoped to one org.
 */
export async function fetchOrgMembers(
  orgId: number,
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<OrgMember[]> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/members`, {
    headers: authHeaders(jwt),
  })
  const body = await readJson<OrgMembersResponse>(res)
  return body.members
}
