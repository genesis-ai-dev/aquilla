import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"
import { UserError } from "@/lib/errors/user-error"

export interface TeamSummary { id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean; isInternal: boolean }
export interface TeamDetail {
  id: number; name: string; description?: string | null
  members: Array<{ userId: number; username: string; roleLevel: number | null }>
  projects: Array<{ id: string; name: string; grantedRoleLevel: number }>
}
function authHeaders(jwt: string): HeadersInit { return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` } }

export async function listTeams(jwt: string, orgId: number): Promise<TeamSummary[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "", "team")
  return ((await res.json()) as { groups: TeamSummary[] }).groups
}
export async function getTeam(jwt: string, orgId: number, groupId: number): Promise<TeamDetail> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "", "team")
  return (await res.json()) as TeamDetail
}

export async function createTeam(jwt: string, orgId: number, name: string, description?: string): Promise<{ id: number; name: string; description: string | null }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(description != null ? { name, description } : { name }) })
  if (!res.ok) throw new UserError(res.status, "", "team")
  return (await res.json()) as { id: number; name: string; description: string | null }
}

export async function updateTeam(jwt: string, orgId: number, groupId: number, patch: { name?: string; description?: string }): Promise<{ id: number; name: string; description: string | null }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify(patch) })
  if (!res.ok) throw new UserError(res.status, "", "team")
  return (await res.json()) as { id: number; name: string; description: string | null }
}

export async function deleteTeam(jwt: string, orgId: number, groupId: number): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}`, { method: "DELETE", headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "", "team")
}

export async function addTeamMember(jwt: string, orgId: number, groupId: number, username: string): Promise<{ userId: number; username: string }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/members`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ username }) })
  if (!res.ok) throw new UserError(res.status, "", "team")
  return (await res.json()) as { userId: number; username: string }
}

export async function removeTeamMember(jwt: string, orgId: number, groupId: number, userId: number): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/members/${userId}`, { method: "DELETE", headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "", "team")
}

export async function attachProject(jwt: string, orgId: number, groupId: number, projectId: string, roleLevel: number): Promise<{ projectId: string; roleLevel: number }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ projectId, roleLevel }) })
  if (!res.ok) throw new UserError(res.status, "", "project")
  return (await res.json()) as { projectId: string; roleLevel: number }
}

export async function changeProjectRole(jwt: string, orgId: number, groupId: number, projectId: string, roleLevel: number): Promise<{ projectId: string; roleLevel: number }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ roleLevel }) })
  if (!res.ok) throw new UserError(res.status, "", "project")
  return (await res.json()) as { projectId: string; roleLevel: number }
}

export async function detachProject(jwt: string, orgId: number, groupId: number, projectId: string): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "", "project")
}
