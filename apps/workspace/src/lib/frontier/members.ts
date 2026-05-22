import { AUTH_BASE } from "./auth";

export interface LookedUpUser {
  id: number;
  username: string;
}

export interface ProjectMemberRole {
  level: number;
  name: string;
  /**
   * Where this role came from in identity's resolveProjectRole tier:
   *   - "override": explicit row in project_members for this user+project
   *   - "creator":  user is the project's `created_by`
   *   - "org":      user has an org_members row for this project's org
   *   - "gitlab":   resolved via GitLab pass-through for legacy projects
   *                 (only ever set when the project has a gitlab_project_id)
   */
  source: "override" | "creator" | "org" | "gitlab";
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
    `${AUTH_BASE}/api/v2/users/lookup?username=${encodeURIComponent(username)}`,
    { headers: authHeaders(jwt) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lookupUser failed: HTTP ${res.status}`);
  return (await res.json()) as LookedUpUser;
}

/**
 * GET /api/v2/projects/:id/members.
 *
 * Returns null when the caller has no server-side access to the project
 * (403) or the project doesn't exist server-side (404). Both are expected
 * conditions for local-only IndexedDB projects on the dashboard, where
 * the avatar stack should silently render empty rather than treat the
 * miss as an error. Real failures (5xx, network) still throw.
 */
export async function listProjectMembers(
  jwt: string,
  projectId: string
): Promise<ProjectMember[] | null> {
  const res = await fetch(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    { headers: authHeaders(jwt) }
  );
  if (res.status === 403 || res.status === 404) return null;
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
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
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
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members/${userId}`,
    { method: "DELETE", headers: authHeaders(jwt) }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`removeProjectMember failed: HTTP ${res.status} — ${text}`);
  }
}
