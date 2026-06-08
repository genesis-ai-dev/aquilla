import { FRONTIER_BASE, AUTH_BASE } from "./auth";

export interface LookedUpUser {
  id: number;
  username: string;
}

export interface ProjectMemberRole {
  level: number;
  name: string;
  /**
   * Where this role came from in auth-worker's resolveProjectRole tier
   * (AD-12 max-wins across four paths):
   *   - "override": explicit row in project_members for this user+project
   *   - "group":    user has access via a group_project_grants + group_members join
   *   - "org":      user has an org_members row for this project's org
   *   - "creator":  user is the project's `created_by`
   *
   * "gitlab" was a v1 legacy field for GitLab pass-through projects. The D1
   * schema has no gitlab_project_id column and auth-worker never returns it.
   */
  source: "override" | "group" | "creator" | "org";
}

/** A non-winning contributing path returned by the members endpoint. */
export interface SecondarySrc {
  source: "override" | "group" | "org" | "creator";
  level: number;
  name: string;
}

export interface ProjectMember {
  userId: number;
  username: string;
  role: ProjectMemberRole;
  /**
   * Every contributing path whose level > 0 except the winning one.
   * Empty when the user has access through only one path.
   */
  secondarySources: SecondarySrc[];
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
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    { headers: authHeaders(jwt) }
  );
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`listProjectMembers failed: HTTP ${res.status}`);
  const body = (await res.json()) as { members: ProjectMember[] };
  return body.members;
}

/**
 * GET /api/v2/orgs/:orgId/members-matrix.
 *
 * One request that returns effective members for every project the caller can
 * access in the org — replaces the per-project listProjectMembers fan-out that
 * flooded the backend (FRO-218). Returns a map of projectId → members. Projects
 * the caller can't access are simply absent from the map (cells render empty),
 * matching the old fan-out's per-project 403→[] collapse.
 */
export async function fetchOrgMembersMatrix(
  jwt: string,
  orgId: number
): Promise<Map<string, ProjectMember[]>> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/members-matrix`,
    { headers: authHeaders(jwt) }
  );
  if (!res.ok) {
    throw new Error(`fetchOrgMembersMatrix failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    projects: { projectId: string; members: ProjectMember[] }[];
  };
  const map = new Map<string, ProjectMember[]>();
  for (const p of body.projects) map.set(p.projectId, p.members);
  return map;
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

export interface RemoteProjectCreateResult {
  id: string
  name: string
  orgId: number | null
  role: { level: number; name: string; source: string }
}

/**
 * POST /api/v2/projects — create a server-side project row in identity.
 * Mirrors the ProjectCreateDialog / main's @aquilla/api-client.createProject.
 * Throws on non-2xx so the caller can surface the error.
 */
export async function createRemoteProject(
  project: { id: string; name: string },
  jwt: string,
): Promise<RemoteProjectCreateResult> {
  const res = await fetch(`${AUTH_BASE}/api/v2/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ id: project.id, name: project.name }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createRemoteProject failed: HTTP ${res.status}${text ? ` — ${text}` : ""}`);
  }
  return (await res.json()) as RemoteProjectCreateResult;
}
