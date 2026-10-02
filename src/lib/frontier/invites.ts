// Client for org-level and platform-level invites/access-links admin routes.
// Every function calls throwIfElevationRequired before checking res.ok so
// a platform admin without a current step-up session gets the step-up prompt.

import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"
import { throwIfElevationRequired } from "./elevation"
import { UserError } from "@/lib/errors/user-error"

const authHeaders = (jwt: string): Record<string, string> => ({
  Authorization: `Bearer ${jwt}`,
})

/** Best-effort extraction of the server's error message for UI display. */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string }
    return body.message || body.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export interface OrgInvite {
  token: string
  role: { level: number; name: string }
  createdAt: string
  expiresAt: string | null
  email: string | null
}

export async function getOrgInvites(jwt: string, orgId: number): Promise<OrgInvite[]> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/invites`,
    { headers: authHeaders(jwt) },
  )
  await throwIfElevationRequired(res, "org invites")
  if (!res.ok) throw new UserError(res.status, await readError(res))
  return ((await res.json()) as { invites: OrgInvite[] }).invites
}

export async function revokeOrgInvite(jwt: string, orgId: number, token: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/invites/${token}`,
    {
      method: "DELETE",
      headers: authHeaders(jwt),
    },
  )
  await throwIfElevationRequired(res, "revoke org invite")
  if (!res.ok) throw new UserError(res.status, await readError(res))
}

export interface CreateAccessLinkRequest {
  projectId: string
  userId: number
  pin: string
  roleLevel?: number
  expiresAt?: string
}

export interface CreateAccessLinkResponse {
  token: string
  projectId: string
  userId: number
  role: number
  expiresAt: string
}

export async function createAccessLink(
  jwt: string,
  body: CreateAccessLinkRequest,
): Promise<CreateAccessLinkResponse> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/access-links`,
    {
      method: "POST",
      headers: { ...authHeaders(jwt), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  await throwIfElevationRequired(res, "create access link")
  if (!res.ok) throw new UserError(res.status, await readError(res))
  return (await res.json()) as CreateAccessLinkResponse
}

export async function revokeAccessLink(jwt: string, token: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/access-links/${token}/revoke`,
    {
      method: "POST",
      headers: authHeaders(jwt),
    },
  )
  await throwIfElevationRequired(res, "revoke access link")
  if (!res.ok) throw new UserError(res.status, await readError(res))
}

export interface CreateMultiProjectInviteRequest {
  projectIds: string[]
  roleLevel?: number
  expiresAt?: string
  scopeLanes?: string[]
}

export interface CreateMultiProjectInviteResponse {
  token: string
  projectIds: string[]
  role: number
  expiresAt: string
  scopeLanes?: string[]
}

export async function createMultiProjectInvite(
  jwt: string,
  body: CreateMultiProjectInviteRequest,
): Promise<CreateMultiProjectInviteResponse> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/invites/multi`,
    {
      method: "POST",
      headers: { ...authHeaders(jwt), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  await throwIfElevationRequired(res, "create multi-project invite")
  if (!res.ok) throw new UserError(res.status, await readError(res))
  return (await res.json()) as CreateMultiProjectInviteResponse
}
