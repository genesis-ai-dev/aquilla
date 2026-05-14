// Typed fetch wrappers for org endpoints.
//
// Mirrors `src/lib/sync/orgs-read.ts`. Strict-failure (non-2xx → throw).

import { AUTH_API_URL } from "./config"

export interface OrgRole {
  level: number
  name: string
}

export interface MyOrg {
  id: number
  name: string | null
  role: OrgRole
}

export interface OrgMember {
  userId: number
  username: string
  role: OrgRole
  lastActiveAt?: string | null
}

export interface OrgMembersResponse {
  members: OrgMember[]
}

export class OrgsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`orgs api failed: HTTP ${status} — ${body.slice(0, 200)}`)
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

export async function fetchUserOrgs(
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<MyOrg> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/me`, { headers: authHeaders(jwt) })
  return await readJson<MyOrg>(res)
}

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
