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
//
// Preview functions (previewServerInvite, previewMultiInvite) return a
// discriminated result so callers can distinguish:
//   {ok: true, data} — preview loaded successfully
//   {ok: false, reason: 'expired'}  — HTTP 410 (token used or expired)
//   {ok: false, reason: 'invalid'}  — HTTP 404 (unknown token)
//   {ok: false, reason: 'network'}  — fetch threw (offline, DNS failure, etc.)

import { AUTH_API_URL } from "./sync-token"
import { ROLE } from "@/lib/frontier/roles"

/**
 * Reason codes for a failed invite preview.
 *
 * - "used"         — the link was already redeemed by someone else (single-use)
 * - "time_expired" — the link's expiry date has passed
 * - "expired"      — legacy catch-all for any 410 response without a server
 *                    code field (servers before FRO-429 fix, or unknown 410)
 * - "invalid"      — 404: the token doesn't exist
 * - "network"      — fetch threw (offline, DNS failure, etc.)
 */
export type InvitePreviewFailReason = "used" | "time_expired" | "expired" | "invalid" | "network"

/** Discriminated result returned by preview functions. */
export type InvitePreviewResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: InvitePreviewFailReason }

/**
 * Reason codes for a failed invite ACCEPT (redeem) call — distinct from
 * InvitePreviewFailReason so callers never conflate "the invite itself is
 * dead" (used/time_expired/invalid) with "the request to redeem it failed
 * for an unrelated reason" (unauthorized/network/server).
 *
 * - "used" / "time_expired" / "invalid" — the invite really is dead (410/404).
 * - "wrong_email"  — 403: this invite was sent to a different address.
 * - "unauthorized" — 401: the caller's session token was rejected. This is
 *   NOT evidence the invite is invalid — surfacing it as "invite dead" is
 *   the FRO-364 bug (a fresh signup's token intermittently 401ing read as a
 *   permanently broken magic link). Callers should re-prompt auth instead.
 * - "network" — fetch threw.
 * - "server"  — any other non-2xx (500s, unexpected codes).
 */
export type AcceptFailReason =
  | "used"
  | "time_expired"
  | "invalid"
  | "wrong_email"
  | "unauthorized"
  | "network"
  | "server"

export type AcceptResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: AcceptFailReason }

/** Classify a non-2xx accept response into an AcceptFailReason. */
async function classifyAcceptFailure(res: Response): Promise<AcceptFailReason> {
  if (res.status === 401) return "unauthorized"
  if (res.status === 403) return "wrong_email"
  if (res.status === 404) return "invalid"
  if (res.status === 410) {
    try {
      const body = (await res.json()) as { code?: string }
      return body.code === "time_expired" ? "time_expired" : "used"
    } catch {
      return "used"
    }
  }
  return "server"
}

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
    // Pass expires_in_days to server (null = no expiry; omit = server default 30 days).
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
 * Returns a discriminated result so callers can distinguish "still loading"
 * from specific failure modes:
 *   {ok:true, data}               — preview loaded
 *   {ok:false, reason:'expired'}  — HTTP 410 (token used or expired)
 *   {ok:false, reason:'invalid'}  — HTTP 404 (unknown token)
 *   {ok:false, reason:'network'}  — fetch threw (offline, DNS failure)
 */
export async function previewServerInvite(
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<InvitePreviewResult<ServerInvitePreview>> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/invite-preview/${encodeURIComponent(token)}`
    )
    if (!res.ok) {
      let reason: InvitePreviewFailReason
      if (res.status === 410) {
        // Parse the server's code field to distinguish used vs time-expired.
        try {
          const body = (await res.json()) as { code?: string }
          reason = body.code === "used" ? "used" : body.code === "time_expired" ? "time_expired" : "expired"
        } catch {
          reason = "expired"
        }
      } else {
        reason = "invalid"
      }
      console.warn(`[invites] previewServerInvite → HTTP ${res.status} (${reason})`)
      return { ok: false, reason }
    }
    return { ok: true, data: (await res.json()) as ServerInvitePreview }
  } catch (err) {
    console.warn("[invites] previewServerInvite failed:", err)
    return { ok: false, reason: "network" }
  }
}

/**
 * POST /api/v2/projects/accept-invite — joiner side.
 *
 * On success the caller is added to project_members at the role the sharer
 * specified, unblocking /sync-token for this project. Returns a discriminated
 * result on failure (see AcceptFailReason) so callers can distinguish "the
 * invite is really dead" from "the request failed for an unrelated reason"
 * (FRO-364: a 401 here is not evidence of a dead invite).
 */
export async function acceptServerInvite(
  jwt: string,
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<AcceptResult<ServerInviteAccepted>> {
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
      const reason = await classifyAcceptFailure(res)
      console.warn(`[invites] acceptServerInvite → HTTP ${res.status} (${reason})`)
      return { ok: false, reason }
    }
    return { ok: true, data: (await res.json()) as ServerInviteAccepted }
  } catch (err) {
    console.warn("[invites] acceptServerInvite failed:", err)
    return { ok: false, reason: "network" }
  }
}

// ── Active invite list + revoke ────────────────────────────────────────────

export interface ActiveProjectInvite {
  token: string
  role: { level: number; name: string }
  createdAt: string
  expiresAt: string | null
  /** Non-null when the invite was minted for a specific email. */
  email: string | null
}

/**
 * GET /api/v2/projects/:projectId/invites — list active (unused + unexpired) invites.
 * Requires project_lead+ role on the project. Returns null on auth/permission error.
 */
export async function listProjectInvites(
  jwt: string,
  projectId: string,
  apiUrl: string = AUTH_API_URL
): Promise<ActiveProjectInvite[] | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/invites`,
      {
        headers: { Authorization: `Bearer ${jwt}` },
      }
    )
    if (!res.ok) {
      console.warn(`[invites] listProjectInvites ${projectId} → HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as { invites: ActiveProjectInvite[] }
    return body.invites
  } catch (err) {
    console.warn("[invites] listProjectInvites failed:", err)
    return null
  }
}

/**
 * DELETE /api/v2/projects/:projectId/invites/:token — revoke an unused invite.
 * Returns true when the invite was deleted, false on 403/404 or network error.
 */
export async function revokeProjectInvite(
  jwt: string,
  projectId: string,
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<boolean> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/invites/${encodeURIComponent(token)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      }
    )
    if (!res.ok) {
      console.warn(`[invites] revokeProjectInvite ${token} → HTTP ${res.status}`)
      return false
    }
    const body = (await res.json()) as { removed: boolean }
    return body.removed
  } catch (err) {
    console.warn("[invites] revokeProjectInvite failed:", err)
    return false
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
  /**
   * `usedByCaller` (FRO-347): true when the signed-in caller is this row's
   * original redeemer and is still a member — i.e. this preview is a
   * "continue" for a link they already used, not a fresh invite. The server
   * only returns already-used rows at all when this is true for at least one
   * of them (otherwise the whole request 410s) — JoinPage doesn't need to
   * branch on it today (the normal confirm-card + accept flow already
   * produces the right friendly no-op redirect), but it's surfaced here so a
   * future "Welcome back" variant of the confirm card can distinguish the
   * two cases without another round-trip.
   */
  projects: { projectId: string; projectName: string; archived: boolean; usedByCaller?: boolean }[]
}

export interface MultiInviteAccepted {
  token: string
  accepted: { projectId: string; role: number }[]
}

/**
 * GET /api/v2/invites/:token/preview — public; lists every project the token grants.
 *
 * Returns a discriminated result (same shape as previewServerInvite):
 *   {ok:true, data}               — preview loaded
 *   {ok:false, reason:'expired'}  — HTTP 410
 *   {ok:false, reason:'invalid'}  — HTTP 404 (or other non-2xx)
 *   {ok:false, reason:'network'}  — fetch threw
 */
export async function previewMultiInvite(
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<InvitePreviewResult<MultiInvitePreview>> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/invites/${encodeURIComponent(token)}/preview`)
    if (!res.ok) {
      let reason: InvitePreviewFailReason
      if (res.status === 410) {
        // Parse the server's code field to distinguish used vs time-expired.
        try {
          const body = (await res.json()) as { code?: string }
          reason = body.code === "used" ? "used" : body.code === "time_expired" ? "time_expired" : "expired"
        } catch {
          reason = "expired"
        }
      } else {
        reason = "invalid"
      }
      console.warn(`[invites] previewMultiInvite → HTTP ${res.status} (${reason})`)
      return { ok: false, reason }
    }
    return { ok: true, data: (await res.json()) as MultiInvitePreview }
  } catch (err) {
    console.warn("[invites] previewMultiInvite failed:", err)
    return { ok: false, reason: "network" }
  }
}

/**
 * POST /api/v2/invites/:token/accept — joiner side; materializes membership
 * in every project. Returns a discriminated result on failure (see
 * AcceptFailReason) — same rationale as acceptServerInvite (FRO-364).
 */
export async function acceptMultiInvite(
  jwt: string,
  token: string,
  apiUrl: string = AUTH_API_URL
): Promise<AcceptResult<MultiInviteAccepted>> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    })
    if (!res.ok) {
      const reason = await classifyAcceptFailure(res)
      console.warn(`[invites] acceptMultiInvite → HTTP ${res.status} (${reason})`)
      return { ok: false, reason }
    }
    return { ok: true, data: (await res.json()) as MultiInviteAccepted }
  } catch (err) {
    console.warn("[invites] acceptMultiInvite failed:", err)
    return { ok: false, reason: "network" }
  }
}

// ── Received invites (FRO-326) ─────────────────────────────────────────────

export interface MyPendingInvite {
  token: string
  role: { level: number; name: string }
  createdBy: string
  createdAt: string
  expiresAt: string | null
  projects: { projectId: string; projectName: string }[]
}

/**
 * GET /api/v2/invites/mine — unredeemed, unexpired invites addressed to the
 * caller's account email (FRO-326). Open links carry no recipient identity
 * and never appear here. Returns [] on any failure — the dashboard card
 * simply doesn't render rather than erroring.
 */
export async function listMyPendingInvites(
  jwt: string,
  apiUrl: string = AUTH_API_URL
): Promise<MyPendingInvite[]> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/invites/mine`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!res.ok) {
      console.warn(`[invites] listMyPendingInvites → HTTP ${res.status}`)
      return []
    }
    return ((await res.json()) as { invites: MyPendingInvite[] }).invites
  } catch (err) {
    console.warn("[invites] listMyPendingInvites failed:", err)
    return []
  }
}
