// Typed fetch wrappers for project-invite endpoints (sharer + joiner sides).
//
// Mirrors `src/lib/sync/invites.ts`. Graceful-failure (null on non-2xx /
// network error), matching the legacy semantics — the UI shows a retry.
// Distinct from the strict `projects.ts` wrappers in this same package
// because invites are user-initiated and a single 4xx shouldn't crash a
// dialog.

import { AUTH_API_URL } from "./config"

export interface ServerInviteCreated {
  token: string
  projectId: string
  role: number
  expiresAt: string
  email?: string
}

export interface ServerInviteAccepted {
  projectId: string
  role: number
}

export interface ServerInvitePreview {
  projectId: string
  projectName: string
  role: { level: number; name: string }
  expiresAt: string | null
  email: string | null
}

/** Default role for link-share invites — contributor (400). Server caps
 *  invites at this level (LINK_ROLE_ALLOWED in roles.ts). */
const DEFAULT_INVITE_ROLE = 400

export async function createServerInvite(
  jwt: string,
  projectId: string,
  role: number = DEFAULT_INVITE_ROLE,
  apiUrl: string = AUTH_API_URL,
  email?: string,
): Promise<ServerInviteCreated | null> {
  try {
    const body: Record<string, unknown> = { role }
    if (email && email.trim().length > 0) body.email = email.trim()
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/invites`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      console.warn(`[invites] createServerInvite ${projectId} → HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as ServerInviteCreated
  } catch (err) {
    console.warn("[invites] createServerInvite failed:", err)
    return null
  }
}

export async function previewServerInvite(
  token: string,
  apiUrl: string = AUTH_API_URL,
): Promise<ServerInvitePreview | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/invite-preview/${encodeURIComponent(token)}`,
    )
    if (!res.ok) {
      console.warn(`[invites] previewServerInvite → HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as ServerInvitePreview
  } catch (err) {
    console.warn("[invites] previewServerInvite failed:", err)
    return null
  }
}

export async function acceptServerInvite(
  jwt: string,
  token: string,
  apiUrl: string = AUTH_API_URL,
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
