/**
 * Group (team) API helpers for E2E specs (FRO-144).
 *
 * All endpoints require maintainer (600)+ on the org unless noted.
 * See aquilla-specs/05-user-stories/access-control-permission-semantics.md
 * §3 "Create team → add project/users to team".
 */

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

export interface CreatedGroup {
  id: number
  name: string
  orgId: number
}

/** POST /api/v2/orgs/:orgId/groups — create a group (team). Requires maintainer+. */
export async function createGroup(
  jwt: string,
  orgId: number,
  name: string,
): Promise<CreatedGroup> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ name }),
  })
  if (!r.ok) throw new Error(`createGroup failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as CreatedGroup
}

/** POST /api/v2/orgs/:orgId/groups/:gid/members — add a user to a group.
 * Target user must already be an org member. Requires maintainer+. */
export async function addGroupMember(
  jwt: string,
  orgId: number,
  groupId: number,
  username: string,
): Promise<void> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/members`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ username }),
  })
  if (!r.ok) throw new Error(`addGroupMember failed: HTTP ${r.status} — ${await r.text()}`)
}

/** DELETE /api/v2/orgs/:orgId/groups/:gid/members/:uid — remove a user from a group.
 * Requires maintainer+. */
export async function removeGroupMember(
  jwt: string,
  orgId: number,
  groupId: number,
  userId: number,
): Promise<void> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/members/${userId}`,
    { method: "DELETE", headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`removeGroupMember failed: HTTP ${r.status} — ${await r.text()}`)
}

/** POST /api/v2/orgs/:orgId/groups/:gid/projects — attach a project to a group.
 * roleLevel must be ≤ caller's own org role. Requires maintainer+. */
export async function attachGroupProject(
  jwt: string,
  orgId: number,
  groupId: number,
  projectId: string,
  roleLevel: number,
): Promise<void> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ projectId, roleLevel }),
  })
  if (!r.ok) throw new Error(`attachGroupProject failed: HTTP ${r.status} — ${await r.text()}`)
}

/** DELETE /api/v2/orgs/:orgId/groups/:gid/projects/:pid — detach project from group.
 * Removes the group path; org + direct paths survive. Requires maintainer+. */
export async function detachGroupProject(
  jwt: string,
  orgId: number,
  groupId: number,
  projectId: string,
): Promise<void> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE", headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`detachGroupProject failed: HTTP ${r.status} — ${await r.text()}`)
}

/** DELETE /api/v2/orgs/:orgId/members/:uid — remove an org member.
 * Cascades: also deletes all group_members rows for this user in this org.
 * Does NOT delete project_members (direct grants survive — see OPQ-2).
 * Requires owner (700). */
export async function removeOrgMember(
  jwt: string,
  orgId: number,
  username: string,
): Promise<void> {
  // Resolve the user id via GET /api/v2/users/lookup?username=X
  const userRes = await fetch(
    `${FRONTIER_BASE}/api/v2/users/lookup?username=${encodeURIComponent(username)}`,
    { headers: authHeaders(jwt) },
  )
  if (!userRes.ok)
    throw new Error(`resolveUser(${username}) failed: HTTP ${userRes.status} — ${await userRes.text()}`)
  const user = (await userRes.json()) as { id: number }

  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${user.id}`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  })
  if (!r.ok) throw new Error(`removeOrgMember failed: HTTP ${r.status} — ${await r.text()}`)
}
