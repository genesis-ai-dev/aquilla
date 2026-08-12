import { FRONTIER_BASE } from "./auth";
import { UserError } from "@/lib/errors/user-error";
import type { MemberGrantResult } from "./members";

/**
 * Default timeout for org/members fetches. Errors out as
 * "request timed out after Ns" instead of leaving the UI hung on a
 * "Loading…" spinner indefinitely. Long enough to tolerate a CF Worker
 * cold start (typically <1s but occasionally several seconds), short
 * enough that a true network/worker failure surfaces quickly.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

function withTimeout(ms: number = DEFAULT_TIMEOUT_MS): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * fetch wrapper that aborts after `ms` and converts the AbortError into a
 * clear "request timed out" error. The plain DOMException("AbortError")
 * is unhelpful in catch blocks; this maps it to something the UI can
 * surface verbatim.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const { signal, cancel } = withTimeout(ms);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request timed out after ${ms / 1000}s — server may be unreachable`);
    }
    throw err;
  } finally {
    cancel();
  }
}

export interface OrgRole {
  level: number;
  name: string;
}

export interface MyOrg {
  id: number;
  name: string | null;
  role: OrgRole;
}

export interface OrgMember {
  userId: number;
  username: string;
  role: OrgRole;
  /** ISO timestamp of last project-context activity by this user in this
   * org. NULL when no activity has been recorded since migration 0018
   * landed. The Members page surfaces this as "Last active X ago" /
   * "No recent activity." */
  lastActiveAt?: string | null;
}

/**
 * One unredeemed, unexpired invite for a project in this org. Returned by
 * `listPendingOrgInvites`. `token` is included so the operator can revoke
 * via DELETE /projects/:id/invites/:token; the listing is owner-gated
 * server-side so token leakage is contained to org admins (who could
 * already revoke anyway).
 */
export interface PendingOrgInvite {
  token: string;
  projectId: string;
  projectName: string;
  role: OrgRole;
  createdBy: { userId: number; username: string };
  createdAt: string;
  expiresAt: string | null;
  /** Non-null when the invite was minted for a specific email recipient.
   * Null means "anyone with the link can redeem" (open link). The Roster
   * surfaces this so the operator can distinguish targeted invites from
   * open shares. */
  email?: string | null;
}

export interface OrgMemberProject {
  id: string;
  name: string;
  role: OrgRole;
}

function authHeaders(jwt: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` };
}

export interface OrgSummary {
  id: number
  name: string | null
  role: OrgRole
  /** True when the org is visible only via the ADMIN_EMAILS allowlist
   *  (not a genuine membership). Server appends these after real orgs. */
  viaPlatformAdmin?: boolean
}

export async function listMyOrgs(jwt: string): Promise<OrgSummary[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "", "org")
  return ((await res.json()) as { orgs: OrgSummary[] }).orgs
}

export async function createOrg(jwt: string, name: string): Promise<OrgSummary> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ name }) })
  if (!res.ok) throw new UserError(res.status, "", "org")
  return (await res.json()) as OrgSummary
}

export async function renameOrg(jwt: string, orgId: number, name: string): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ name }) })
  if (!res.ok) throw new UserError(res.status, "", "org")
}

// ── Email-based org invitations (owner-only; backend: routes/orgs.ts) ──────

export interface OrgInviteResult {
  token: string;
  orgId: number;
  role: OrgRole;
  expiresAt: string | null;
  email?: string;
}

/** Mint an org invite. Pass an email to email-bind the invite and deliver it. */
export async function createOrgInvite(
  jwt: string,
  orgId: number,
  opts: { email?: string; role?: number; expiresInDays?: number | null } = {},
): Promise<OrgInviteResult> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/invites`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.role != null ? { role: opts.role } : {}),
      ...(opts.expiresInDays !== undefined ? { expires_in_days: opts.expiresInDays } : {}),
    }),
  });
  if (!res.ok) throw new UserError(res.status, "", "org");
  return (await res.json()) as OrgInviteResult;
}

/** Public preview of an org invite (AQU-471) — what JoinOrgPage shows before
 * the recipient signs in / accepts. */
export interface OrgInvitePreview {
  orgId: number;
  orgName: string | null;
  /** Inviter's display name (fallback username); null if the account is gone. */
  invitedBy: string | null;
  role: OrgRole;
  expiresAt: string | null;
  email: string | null;
}

/**
 * GET /api/v2/orgs/invite-preview/:token — public, no JWT. Returns null on ANY
 * failure (unknown/expired/used token, old server, network): JoinOrgPage falls
 * back to its generic copy and the accept endpoint stays the authority on
 * token validity.
 */
export async function previewOrgInvite(token: string): Promise<OrgInvitePreview | null> {
  try {
    const res = await fetchWithTimeout(
      `${FRONTIER_BASE}/api/v2/orgs/invite-preview/${encodeURIComponent(token)}`,
      {},
    );
    if (!res.ok) {
      console.warn(`[org-invites] previewOrgInvite → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as OrgInvitePreview;
  } catch (err) {
    console.warn("[org-invites] previewOrgInvite failed:", err);
    return null;
  }
}

export interface AcceptOrgInviteResult {
  orgId: number;
  orgName: string | null;
  role: OrgRole;
}

export async function acceptOrgInvite(jwt: string, token: string): Promise<AcceptOrgInviteResult> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/accept-invite`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new UserError(res.status, "", "org");
  return (await res.json()) as AcceptOrgInviteResult;
}

export interface ProjectAccessBreakdown {
  projectId: string
  projectName: string
  direct: number | null
  groups: { groupId: number; name: string; roleLevel: number }[]
  org: number | null
  creator: boolean
  resolved: number
}
export interface MemberEffectiveAccess {
  orgRole: number | null
  projects: ProjectAccessBreakdown[]
}

/** AD-12 effective-access breakdown for one member: every grant path per project + resolved max. */
export async function getMemberAccess(jwt: string, orgId: number, userId: number): Promise<MemberEffectiveAccess> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}/access`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "", "org")
  return (await res.json()) as MemberEffectiveAccess
}

export async function getOrCreateMyOrg(jwt: string): Promise<MyOrg> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/me`, {
    headers: authHeaders(jwt),
  });
  if (!res.ok) throw new UserError(res.status, "", "org");
  return (await res.json()) as MyOrg;
}

export async function listOrgMembers(jwt: string, orgId: number): Promise<OrgMember[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    headers: authHeaders(jwt),
  });
  if (!res.ok) throw new UserError(res.status, "", "org");
  return ((await res.json()) as { members: OrgMember[] }).members;
}

/**
 * AQU-485: discriminated result for the org roster fetch, distinguishing
 * "not an org member at all" from "org policy hides the roster" — both are
 * 403s server-side, but surfaces that render the Members page need to show
 * "hidden by org policy" rather than a generic error or an empty roster.
 * Prefer this over `listOrgMembers` wherever that distinction matters.
 */
export type OrgRosterResult =
  | { kind: "ok"; members: OrgMember[] }
  | { kind: "no-access" }
  | { kind: "roster-hidden" };

/**
 * GET /api/v2/orgs/:orgId/members, preserving the AQU-485
 * roster-hidden-by-policy signal (`rosterHidden: true` in the 403 body).
 */
export async function fetchOrgRoster(jwt: string, orgId: number): Promise<OrgRosterResult> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    headers: authHeaders(jwt),
  });
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { rosterHidden?: boolean } | null;
    return body?.rosterHidden ? { kind: "roster-hidden" } : { kind: "no-access" };
  }
  if (!res.ok) throw new UserError(res.status, "", "org");
  const members = ((await res.json()) as { members: OrgMember[] }).members;
  return { kind: "ok", members };
}

export async function addOrgMember(
  jwt: string, orgId: number, username: string, role: number
): Promise<OrgMember> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ username, role }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UserError(res.status, text, "org");
  }
  return (await res.json()) as OrgMember;
}

/**
 * Grant several people the same-or-per-person role on an org in ONE request
 * (AQU-736). Non-atomic — returns the per-person `results` in request order.
 */
export async function addOrgMembers(
  jwt: string, orgId: number, members: Array<{ username: string; role: number }>
): Promise<MemberGrantResult[]> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ members }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UserError(res.status, text, "org");
  }
  return ((await res.json()) as { results: MemberGrantResult[] }).results;
}

export async function removeOrgMember(
  jwt: string, orgId: number, userId: number
): Promise<void> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UserError(res.status, text, "org");
  }
}

export async function listOrgMemberProjects(
  jwt: string, orgId: number, userId: number
): Promise<OrgMemberProject[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}/projects`,
    { headers: authHeaders(jwt) }
  );
  if (!res.ok) throw new UserError(res.status, "", "org");
  return ((await res.json()) as { projects: OrgMemberProject[] }).projects;
}

/**
 * GET /api/v2/orgs/:orgId/project-invites — pending invites for projects in
 * this org. Owner-only server-side; returns null on 403 (caller isn't
 * owner) so the Roster can hide the "Pending" section gracefully without
 * surfacing the gate as an error. Throws on other failures.
 *
 * Distinct path from `/invites` (org-level org_invites, see
 * `createOrgInvite`/`listOrgInvites`) — those used to share this path and
 * the org_invites handler (registered first) silently shadowed this one.
 */
export async function listPendingOrgInvites(
  jwt: string,
  orgId: number
): Promise<PendingOrgInvite[] | null> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/project-invites`, {
    headers: authHeaders(jwt),
  });
  if (res.status === 403) return null;
  if (!res.ok) throw new UserError(res.status, "", "org");
  return ((await res.json()) as { invites: PendingOrgInvite[] }).invites;
}

/**
 * DELETE /api/v2/projects/:projectId/invites/:token — revoke a pending invite.
 * Server returns `{ removed: boolean }` (idempotent: removed=false when the
 * token doesn't match anything pending, e.g. it was already redeemed or
 * revoked elsewhere). 403 throws.
 */
export async function revokeProjectInvite(
  jwt: string,
  projectId: string,
  token: string
): Promise<boolean> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(
      projectId
    )}/invites/${encodeURIComponent(token)}`,
    { method: "DELETE", headers: authHeaders(jwt) }
  );
  if (!res.ok) {
    throw new UserError(res.status, "", "invite");
  }
  return ((await res.json()) as { removed: boolean }).removed;
}
