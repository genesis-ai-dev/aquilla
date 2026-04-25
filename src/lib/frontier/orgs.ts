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
