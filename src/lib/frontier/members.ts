import { FRONTIER_BASE, AUTH_BASE } from "./auth";
import { UserError } from "@/lib/errors/user-error";

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

/**
 * AQU-454: split an effective-member roster into people granted access to a
 * specific project (a direct `project_members` grant, a group attachment, or
 * being the creator) versus people who only reach it through an org-wide role.
 * Org members inherit access to every project via AD-12 max-wins
 * (04-features/members-and-sharing.md), so a large org otherwise floods each
 * project's roster. A member counts as project-specific if ANY of their
 * contributing paths (winning or secondary) is override/group/creator;
 * org-baseline-only members have `org` as their sole path. Input order is
 * preserved within each bucket.
 */
export function partitionMembers(members: ProjectMember[]): {
  projectMembers: ProjectMember[];
  orgAccessMembers: ProjectMember[];
} {
  const projectMembers: ProjectMember[] = [];
  const orgAccessMembers: ProjectMember[] = [];
  for (const m of members) {
    const paths = [m.role.source, ...(m.secondarySources ?? []).map((s) => s.source)];
    const hasProjectPath = paths.some(
      (s) => s === "override" || s === "group" || s === "creator"
    );
    if (hasProjectPath) projectMembers.push(m);
    else orgAccessMembers.push(m);
  }
  return { projectMembers, orgAccessMembers };
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
  if (!res.ok) throw new UserError(res.status, "", "user");
  return (await res.json()) as LookedUpUser;
}

/**
 * AQU-485: discriminated result for the roster fetch, distinguishing "no
 * server-side access at all" from "org policy hides the roster" — the two
 * collapse to the same `null` in the legacy `listProjectMembers` wrapper
 * below, but callers that need to render "roster hidden by policy" (rather
 * than a misleading "no members yet") should use this instead.
 */
export type ProjectRosterResult =
  | { kind: "ok"; members: ProjectMember[] }
  | { kind: "no-access" }
  | { kind: "roster-hidden" }

/**
 * GET /api/v2/projects/:id/members, preserving the AQU-485
 * roster-hidden-by-policy signal (`rosterHidden: true` in the 403 body) so
 * callers can render "hidden by org policy" distinctly from "no access" /
 * "genuinely empty."
 */
export async function fetchProjectRoster(
  jwt: string,
  projectId: string,
): Promise<ProjectRosterResult> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    { headers: authHeaders(jwt) }
  );
  if (res.status === 403) {
    const body = await res.json().catch(() => null) as { rosterHidden?: boolean } | null;
    return body?.rosterHidden ? { kind: "roster-hidden" } : { kind: "no-access" };
  }
  if (res.status === 404) return { kind: "no-access" };
  if (!res.ok) throw new UserError(res.status, "", "project");
  const body = (await res.json()) as { members: ProjectMember[] };
  return { kind: "ok", members: body.members };
}

/**
 * GET /api/v2/projects/:id/members.
 *
 * Returns null when the caller has no server-side access to the project
 * (403) or the project doesn't exist server-side (404), OR when org policy
 * hides the roster (AQU-485 rosterViewMinRole). All three are expected
 * conditions for callers that don't distinguish them (e.g. the dashboard
 * avatar stack, which should silently render empty either way). Callers
 * that need to show "hidden by org policy" distinctly should use
 * `fetchProjectRoster` instead. Real failures (5xx, network) still throw.
 */
export async function listProjectMembers(
  jwt: string,
  projectId: string
): Promise<ProjectMember[] | null> {
  const result = await fetchProjectRoster(jwt, projectId);
  return result.kind === "ok" ? result.members : null;
}

/**
 * GET /api/v2/orgs/:orgId/members-matrix.
 *
 * One request that returns effective members for every project the caller can
 * access in the org — replaces the per-project listProjectMembers fan-out that
 * flooded the backend (AQU-218). Returns a map of projectId → members. Projects
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
    throw new UserError(res.status, "", "org");
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
    const text = await res.text().catch(() => "");
    throw new UserError(res.status, text, "project");
  }
  return (await res.json()) as ProjectMember;
}

/**
 * One entry in a batch membership-grant response (AQU-736). The endpoints are
 * deliberately non-atomic: each person is evaluated independently, so a batch
 * reports per-person success/failure rather than all-or-nothing. `error.code`
 * is stable + machine-readable (e.g. `user_not_found`, `self_grant`,
 * `role_above_caller`, `target_outranks_caller`, `not_org_member`).
 */
export interface MemberGrantResult {
  username: string;
  ok: boolean;
  error?: { code: string; message: string };
}

/**
 * Grant several people the same-or-per-person role on a project in ONE request.
 * Returns the per-person `results` in request order so the caller can show who
 * succeeded and name anyone who failed. Only a malformed batch (empty, non-array,
 * or over the 100-person cap) or a whole-request auth failure throws.
 */
export async function addProjectMembers(
  jwt: string,
  projectId: string,
  members: Array<{ username: string; role: number }>
): Promise<MemberGrantResult[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ members }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UserError(res.status, text, "project");
  }
  return ((await res.json()) as { results: MemberGrantResult[] }).results;
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
    const text = await res.text().catch(() => "");
    throw new UserError(res.status, text, "project");
  }
}

export interface RevokeAllResult {
  /** True when a direct project_members row was deleted. */
  removed: boolean
  /**
   * Every grant path the target had (including non-removable ones like org,
   * group, creator). The UI uses this to inform the caller which paths still
   * grant access even after the direct grant was removed.
   */
  grantPaths: Array<{
    source: string
    level: number
    name: string
    /** True iff this path was (or can be) removed by revoke-all. */
    removable: boolean
    /** Human-readable hint for non-removable paths. */
    hint?: string
  }>
}

/**
 * POST /api/v2/projects/:projectId/members/:userId/revoke-all
 *
 * Removes the target user's direct project_members row and returns the full
 * set of grant paths so the UI can explain which paths still grant access.
 * Requires MAINTAINER (600)+ on the project. Throws on non-2xx.
 */
export async function revokeAllProjectAccess(
  jwt: string,
  projectId: string,
  userId: number,
): Promise<RevokeAllResult> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members/${userId}/revoke-all`,
    {
      method: "POST",
      headers: authHeaders(jwt),
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new UserError(res.status, text, "project")
  }
  return (await res.json()) as RevokeAllResult
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
  orgId?: number,
): Promise<RemoteProjectCreateResult> {
  const res = await fetch(`${AUTH_BASE}/api/v2/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      id: project.id,
      name: project.name,
      ...(orgId != null ? { orgId } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UserError(res.status, text, "project");
  }
  return (await res.json()) as RemoteProjectCreateResult;
}
