import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"

export interface TeamSummary { id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean }
export interface TeamDetail {
  id: number; name: string
  members: Array<{ userId: number; username: string; roleLevel: number | null }>
  projects: Array<{ id: string; name: string; grantedRoleLevel: number }>
}
function authHeaders(jwt: string): HeadersInit { return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` } }

export async function listTeams(jwt: string, orgId: number): Promise<TeamSummary[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`listTeams failed: HTTP ${res.status}`)
  return ((await res.json()) as { groups: TeamSummary[] }).groups
}
export async function getTeam(jwt: string, orgId: number, groupId: number): Promise<TeamDetail> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/groups/${groupId}`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getTeam failed: HTTP ${res.status}`)
  return (await res.json()) as TeamDetail
}
