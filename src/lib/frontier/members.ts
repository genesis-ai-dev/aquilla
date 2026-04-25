import { FRONTIER_BASE } from "./auth";

export interface LookedUpUser {
  id: number;
  username: string;
}

export interface ProjectMemberRole {
  level: number;
  name: string;
  source: "override" | "creator" | "org";
}

export interface ProjectMember {
  userId: number;
  username: string;
  role: ProjectMemberRole;
}

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  };
}

export async function lookupUser(jwt: string, username: string): Promise<LookedUpUser | null> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/users/lookup?username=${encodeURIComponent(username)}`,
    { headers: authHeaders(jwt) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lookupUser failed: HTTP ${res.status}`);
  return (await res.json()) as LookedUpUser;
}

export async function listProjectMembers(jwt: string, projectId: string): Promise<ProjectMember[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    { headers: authHeaders(jwt) }
  );
  if (!res.ok) throw new Error(`listProjectMembers failed: HTTP ${res.status}`);
  const body = (await res.json()) as { members: ProjectMember[] };
  return body.members;
}

export async function addProjectMember(
  jwt: string,
  projectId: string,
  username: string,
  role: number
): Promise<ProjectMember> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ username, role }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`addProjectMember failed: HTTP ${res.status} — ${text}`);
  }
  return (await res.json()) as ProjectMember;
}

export async function removeProjectMember(
  jwt: string,
  projectId: string,
  userId: number
): Promise<void> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members/${userId}`,
    { method: "DELETE", headers: authHeaders(jwt) }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`removeProjectMember failed: HTTP ${res.status} — ${text}`);
  }
}
