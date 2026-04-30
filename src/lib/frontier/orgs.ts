import { FRONTIER_BASE } from "./auth";

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
}

export interface OrgMemberProject {
  id: string;
  name: string;
  role: OrgRole;
}

function authHeaders(jwt: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` };
}

export async function getOrCreateMyOrg(jwt: string): Promise<MyOrg> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/me`, { headers: authHeaders(jwt) });
  if (!res.ok) throw new Error(`getOrCreateMyOrg failed: HTTP ${res.status}`);
  return (await res.json()) as MyOrg;
}

export async function listOrgMembers(jwt: string, orgId: number): Promise<OrgMember[]> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    headers: authHeaders(jwt),
  });
  if (!res.ok) throw new Error(`listOrgMembers failed: HTTP ${res.status}`);
  return ((await res.json()) as { members: OrgMember[] }).members;
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
    const text = await res.text();
    throw new Error(`addOrgMember failed: HTTP ${res.status} — ${text}`);
  }
  return (await res.json()) as OrgMember;
}

export async function removeOrgMember(
  jwt: string, orgId: number, userId: number
): Promise<void> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`removeOrgMember failed: HTTP ${res.status} — ${text}`);
  }
}

export async function listOrgMemberProjects(
  jwt: string, orgId: number, userId: number
): Promise<OrgMemberProject[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}/projects`,
    { headers: authHeaders(jwt) }
  );
  if (!res.ok) throw new Error(`listOrgMemberProjects failed: HTTP ${res.status}`);
  return ((await res.json()) as { projects: OrgMemberProject[] }).projects;
}

/**
 * GET /api/v2/orgs/:orgId/invites — pending invites for projects in this org.
 * Owner-only server-side; returns null on 403 (caller isn't owner) so the
 * Roster can hide the "Pending" section gracefully without surfacing the
 * gate as an error. Throws on other failures.
 */
export async function listPendingOrgInvites(
  jwt: string,
  orgId: number
): Promise<PendingOrgInvite[] | null> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/invites`, {
    headers: authHeaders(jwt),
  });
  if (res.status === 403) return null;
  if (!res.ok) throw new Error(`listPendingOrgInvites failed: HTTP ${res.status}`);
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
    throw new Error(`revokeProjectInvite failed: HTTP ${res.status}`);
  }
  return ((await res.json()) as { removed: boolean }).removed;
}
