// Client helpers for auth-worker's project-invite endpoints.
//
// TWO INVITE FLOWS — intentionally separate UX surfaces:
//
//   Single-project invite (this file + auth-worker/routes/projects-invites.ts):
//     Used by the project Share panel (Dashboard → ProjectCard → ShareDialog).
//     Creates one invite token scoped to a single projectId. Any role up to
//     ROLE.CONTRIBUTOR (400) is allowed. This is the standard "share this
//     project" flow for project owners/leads.
//
//   Multi-project invite (auth-worker/routes/invites.ts POST /multi):
//     Used by MembersPage → MultiProjectInviteDialog (org-admin surface only).
//     Creates one token that spans N projects in a single accept call. Intended
//     for org admins onboarding a whole team to a workspace. Not wired to
//     Dashboard; org-admin-only by design.
//
// Graceful degradation: helpers return null on failure (no jwt, HTTP error,
// network error). Callers surface null as "couldn't create / preview / accept"
// and log — the UI shows a retry path.

import { AUTH_API_URL } from "./sync-token"
import { ROLE } from "@/lib/frontier/roles"

export interface ServerInviteCreated {
  token: string
  projectId: string
  role: number
  expiresAt: string
  /** Echoed back when the invite was bound to a specific email. Null/absent
   * for "anyone with the link" invites. */
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
  /** Non-null when the invite was minted for a specific email — used by
   * the JoinPage to prefill the sign-up form. Null for "anyone with the
   * link" invites. */
  email: string | null
}

/**
 * POST /api/v2/projects/:projectId/invites — sharer side.
 *
 * role defaults to ROLE.CONTRIBUTOR (400), which matches the implicit level
 * the old client-only share flow granted. Server enforces a hard cap at
 * contributor for link-share invites (LINK_ROLE_ALLOWED in roles.ts);
 * sharer must also have role_level >= 500 (project_lead) on the project.
 * A 403 shows up as null.
 *
 * Optional `email` binds the invite to a specific recipient. The token is
 * still the auth credential — anyone holding it can redeem after signup —
 * but the email lets the JoinPage prefill the sign-up form when the
 * recipient lacks a Frontier account.
 */
export async function createServerInvite(
  jwt: string,
  projectId: string,
  role: number = ROLE.CONTRIBUTOR,
  apiUrl: string = AUTH_API_URL,
  email?: string,
  /** Expiry in days. Pass null for no expiry. If undefined, server default applies. */
  expiresInDays?: number | null
): Promise<ServerInviteCreated | null> {
  try {
    const body: Record<string, unknown> = { role }
    if (email && email.trim().length > 0) body.email = email.trim()
    // SWARM-TODO: confirm server accepts expires_in_days or equivalent TTL field.
    if (expiresInDays !== undefined) body.expires_in_days = expiresInDays
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/invites`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(body),
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
 * GET /api/v2/projects/invite-preview/:token — public, no JWT required.
 *
 * Returns project + role metadata so the JoinPage can render context
 * before the recipient signs in. 404 (unknown token) and 410 (used /
 * expired) both surface as null with a console warning; the page renders
 * an "invite no longer valid" empty state.
 */
export async function previewServerInvite(
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<ServerInvitePreview | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/invite-preview/${encodeURIComponent(token)}`
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
  apiUrl: string = AUTH_API_URL
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

// ── Multi-project invite (one token spanning N projects) ───────────────────
// The org-admin MultiProjectInviteDialog mints these; the endpoints live in
// auth-worker/routes/invites.ts. The preview/accept query project_invites by
// token, so they return 1 row for a single-project token too — JoinPage tries
// the multi endpoint first and falls back to the single-project flow.

export interface MultiInvitePreview {
  token: string
  role: { level: number; name: string }
  expiresAt: string | null
  projects: { projectId: string; projectName: string; archived: boolean }[]
}

export interface MultiInviteAccepted {
  token: string
  accepted: { projectId: string; role: number }[]
}

/** GET /api/v2/invites/:token/preview — public; lists every project the token grants. */
export async function previewMultiInvite(
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<MultiInvitePreview | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/invites/${encodeURIComponent(token)}/preview`)
    if (!res.ok) {
      console.warn(`[invites] previewMultiInvite → HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as MultiInvitePreview
  } catch (err) {
    console.warn("[invites] previewMultiInvite failed:", err)
    return null
  }
}

/** POST /api/v2/invites/:token/accept — joiner side; materializes membership in every project. */
export async function acceptMultiInvite(
  jwt: string,
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<MultiInviteAccepted | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    })
    if (!res.ok) {
      console.warn(`[invites] acceptMultiInvite → HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as MultiInviteAccepted
  } catch (err) {
    console.warn("[invites] acceptMultiInvite failed:", err)
    return null
  }
}
