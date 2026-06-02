// Client for the site-wide admin surface (/api/v2/admin/*). The server gates
// every endpoint on the PLATFORM_ADMINS allowlist (a separate axis from the
// org role ladder); a non-admin caller gets 403. The SPA never treats this
// as a security boundary — it calls `getAdminMe` to decide whether to render
// the /admin route, but the worker is the real gate.

import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"

const authHeaders = (jwt: string): Record<string, string> => ({
  Authorization: `Bearer ${jwt}`,
})

export interface AdminOverview {
  orgs: number
  teams: number
  users: number
  activeProjects: number
  archivedProjects: number
  activeUsers7d: number
}

export interface AdminTeam {
  id: number
  name: string
  createdAt: string
  orgId: number
  orgName: string | null
  memberCount: number
  projectCount: number
}

export interface AdminOrg {
  id: number
  name: string | null
  createdAt: string
  ownerUsername: string | null
  memberCount: number
  projectCount: number
}

export interface AdminUser {
  id: number
  username: string
  email: string
  displayName: string | null
  createdAt: string
  orgCount: number
  lastActiveAt: string | null
}

export interface AdminProject {
  id: string
  name: string
  orgId: number | null
  orgName: string | null
  archived: boolean
  createdAt: string
  deadlineAt: string | null
  creatorUsername: string | null
  totalCells: number
  validatedCells: number
  wordCount: number
  lastEditAt: number | null
}

export interface AdminActivity {
  id: number
  userId: number
  username: string | null
  type: string | null
  description: string | null
  timestamp: string
}

/**
 * Probe whether the current session is a platform admin. Resolves to false on
 * 403 (ordinary user) and re-throws only on unexpected transport/server
 * errors, so callers can gate UI without a try/catch for the common case.
 */
export async function getAdminMe(jwt: string): Promise<boolean> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/me`, { headers: authHeaders(jwt) })
  if (res.status === 403 || res.status === 401) return false
  if (!res.ok) throw new Error(`getAdminMe failed: HTTP ${res.status}`)
  const body = (await res.json()) as { isPlatformAdmin?: boolean }
  return body.isPlatformAdmin === true
}

export async function getAdminOverview(jwt: string): Promise<AdminOverview> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/overview`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getAdminOverview failed: HTTP ${res.status}`)
  return (await res.json()) as AdminOverview
}

export async function getAdminOrgs(jwt: string): Promise<AdminOrg[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/orgs`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getAdminOrgs failed: HTTP ${res.status}`)
  return ((await res.json()) as { orgs: AdminOrg[] }).orgs
}

export async function getAdminTeams(jwt: string): Promise<AdminTeam[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/teams`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getAdminTeams failed: HTTP ${res.status}`)
  return ((await res.json()) as { teams: AdminTeam[] }).teams
}

export async function getAdminUsers(jwt: string): Promise<AdminUser[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/users`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getAdminUsers failed: HTTP ${res.status}`)
  return ((await res.json()) as { users: AdminUser[] }).users
}

export async function getAdminProjects(jwt: string): Promise<AdminProject[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/projects`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getAdminProjects failed: HTTP ${res.status}`)
  return ((await res.json()) as { projects: AdminProject[] }).projects
}

export async function getAdminActivity(jwt: string, limit = 100): Promise<AdminActivity[]> {
  const url = `${FRONTIER_BASE}/api/v2/admin/activity?limit=${encodeURIComponent(String(limit))}`
  const res = await fetchWithTimeout(url, { headers: authHeaders(jwt) })
  if (!res.ok) throw new Error(`getAdminActivity failed: HTTP ${res.status}`)
  return ((await res.json()) as { activity: AdminActivity[] }).activity
}
