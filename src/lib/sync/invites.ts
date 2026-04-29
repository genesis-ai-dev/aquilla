// Client helpers for frontier-server's project-invite endpoints.
// Separate from share-tokens.ts (IndexedDB-only client invites) so the
// server wire concerns don't leak into the offline-capable local flow.
//
// Graceful degradation: both helpers return null on failure (no jwt, HTTP
// error, network error). Callers treat null as "we couldn't register this
// with the server — fall back to local-only" and log.

import { FRONTIER_API_URL } from "./sync-token"
import { ROLE } from "@/lib/frontier/roles"

export interface ServerInviteCreated {
  token: string
  projectId: string
  role: number
  expiresAt: string
}

export interface ServerInviteAccepted {
  projectId: string
  role: number
}

/**
 * POST /api/v2/projects/:projectId/invites — sharer side.
 *
 * role defaults to ROLE.CONTRIBUTOR (400), which matches the implicit level
 * the old client-only share flow granted. Server enforces a hard cap at
 * contributor for link-share invites (LINK_ROLE_ALLOWED in roles.ts);
 * sharer must also have role_level >= 500 (project_lead) on the project.
 * A 403 shows up as null.
 */
export async function createServerInvite(
  jwt: string,
  projectId: string,
  role: number = ROLE.CONTRIBUTOR,
  apiUrl: string = FRONTIER_API_URL
): Promise<ServerInviteCreated | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/invites`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ role }),
      }
    )
    if (!res.ok) {
      console.warn(
        `[invites] createServerInvite ${projectId} → HTTP ${res.status}`
      )
      return null
    }
    return (await res.json()) as ServerInviteCreated
  } catch (err) {
    console.warn("[invites] createServerInvite failed:", err)
    return null
  }
}

/**
 * POST /api/v2/projects/accept-invite — joiner side.
 *
 * On success the caller is added to project_members at the role the sharer
 * specified, unblocking /sync-token for this project. 404/410/500 returns null;
 * joiner can still view the project locally but sync-worker writes will 401.
 */
export async function acceptServerInvite(
  jwt: string,
  token: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<ServerInviteAccepted | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/projects/accept-invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) {
      console.warn(`[invites] acceptServerInvite → HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as ServerInviteAccepted
  } catch (err) {
    console.warn("[invites] acceptServerInvite failed:", err)
    return null
  }
}
