// Client for the site-wide admin surface (/api/v2/admin/*). The server gates
// every endpoint on the ADMIN_EMAILS allowlist (a separate axis from the
// org role ladder); a non-admin caller gets 403. The SPA never treats this
// as a security boundary — it calls `getAdminMe` to decide whether to render
// the /admin route, but the worker is the real gate.

import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"
import { UserError } from "@/lib/errors/user-error"

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
 * One ADMIN_EMAILS allowlist entry. `hasAccount: false` means the email is
 * allowlisted in wrangler.toml but no user row matches it (typo or
 * not-yet-registered) — surfaced so the list stays auditable from the UI.
 */
export interface AdminAdmin {
  email: string
  hasAccount: boolean
  userId?: number
  username?: string
  displayName?: string | null
  createdAt?: string
  lastActiveAt?: string | null
}

/**
 * Identity + elevation status for the current session. `hardened` reflects
 * whether the console requires the step-up gate; when it does, `elevated` says
 * whether a fresh step-up code has been entered (≤6h ago).
 */
export interface AdminMe {
  isPlatformAdmin: boolean
  username: string
  email: string
  hardened: boolean
  elevated: boolean
  elevatedUntil: string | null
}

/** Champion/challenger experiment on the default chat model (mirrors auth-worker AbTestConfig). */
export interface AbTestConfig {
  enabled: boolean
  challengerModel: string
  /** 0–100: share of default-model traffic served by the challenger. */
  trafficPct: number
}

/** Global, runtime-editable AI config (mirrors auth-worker PlatformSettings). */
export interface PlatformSettings {
  defaultLlmModel?: string
  agentModel?: string
  allowedModels?: string[]
  aiUserDailyLimit?: number
  aiGlobalDailyLimit?: number
  aiBudgetEnforce?: boolean
  abTest?: AbTestConfig
}

export interface PlatformSettingsResponse {
  settings: PlatformSettings
  version: number
  updatedAt: string | null
  updatedBy: number | null
  /** The values actually in force right now (store value OR env fallback). */
  effective: {
    defaultLlmModel: string
    agentModel: string
    allowedModels: string[]
  }
}

/** Best-effort extraction of the server's error message for UI display. */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string }
    return body.message || body.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * Probe whether the current session is a platform admin. Resolves to false on
 * 403 (ordinary user) and re-throws only on unexpected transport/server
 * errors, so callers can gate UI without a try/catch for the common case.
 */
export async function getAdminMe(jwt: string): Promise<boolean> {
  return (await getAdminStatus(jwt)) !== null
}

/**
 * Full admin identity + elevation status. Resolves to null on 403/401 (account
 * email not in the ADMIN_EMAILS allowlist), else the AdminMe object.
 */
export async function getAdminStatus(jwt: string): Promise<AdminMe | null> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/me`, { headers: authHeaders(jwt) })
  if (res.status === 403 || res.status === 401) return null
  if (!res.ok) throw new UserError(res.status, "")
  const body = (await res.json()) as AdminMe
  return body.isPlatformAdmin ? body : null
}

/**
 * Request a step-up elevation code, emailed to the admin's account address.
 * In local/e2e (no mail binding) the server returns the code as `devCode` so
 * the flow is testable; production always emails and never returns it.
 */
export async function requestAdminElevation(jwt: string): Promise<{ sent: boolean; devCode?: string }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/elevation/request`, {
    method: "POST",
    headers: { ...authHeaders(jwt), "Content-Type": "application/json" },
  })
  if (!res.ok) throw new UserError(res.status, await readError(res))
  const body = (await res.json()) as { ok: boolean; sent: boolean; devCode?: string }
  return { sent: body.sent, devCode: body.devCode }
}

/** Exchange a code for a ~6h elevated session. Throws UserError(400) on a bad code. */
export async function verifyAdminElevation(jwt: string, code: string): Promise<{ elevatedUntil: string }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/elevation/verify`, {
    method: "POST",
    headers: { ...authHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) throw new UserError(res.status, await readError(res))
  return (await res.json()) as { elevatedUntil: string }
}

export async function getPlatformSettings(jwt: string): Promise<PlatformSettingsResponse> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/settings`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, await readError(res))
  return (await res.json()) as PlatformSettingsResponse
}

export async function updatePlatformSettings(
  jwt: string,
  patch: PlatformSettings & { ifMatchVersion: number },
): Promise<{ settings: PlatformSettings; version: number }> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/settings`, {
    method: "PATCH",
    headers: { ...authHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new UserError(res.status, await readError(res))
  return (await res.json()) as { settings: PlatformSettings; version: number }
}

/** One model/arm aggregate from GET /api/v2/admin/ab-results. */
export interface AbResultRow {
  model: string
  arm: "champion" | "challenger"
  requests: number
  errors: number
  accepted: number
  edited: number
  rejected: number
  avgLatencyMs: number | null
  /** Mean normalized edit distance [0,1] over decided drafts — lower = better. */
  avgEditDistance: number | null
}

export async function getAbResults(jwt: string, days = 30): Promise<{ days: number; results: AbResultRow[] }> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/admin/ab-results?days=${encodeURIComponent(String(days))}`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) throw new UserError(res.status, await readError(res))
  return (await res.json()) as { days: number; results: AbResultRow[] }
}

export async function getAdminAdmins(jwt: string): Promise<AdminAdmin[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/admins`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "")
  return ((await res.json()) as { admins: AdminAdmin[] }).admins
}

export async function getAdminOverview(jwt: string): Promise<AdminOverview> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/overview`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "")
  return (await res.json()) as AdminOverview
}

export async function getAdminOrgs(jwt: string): Promise<AdminOrg[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/orgs`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "")
  return ((await res.json()) as { orgs: AdminOrg[] }).orgs
}

export async function getAdminTeams(jwt: string): Promise<AdminTeam[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/teams`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "")
  return ((await res.json()) as { teams: AdminTeam[] }).teams
}

export async function getAdminUsers(jwt: string): Promise<AdminUser[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/users`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "")
  return ((await res.json()) as { users: AdminUser[] }).users
}

export async function getAdminProjects(jwt: string): Promise<AdminProject[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/admin/projects`, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "")
  return ((await res.json()) as { projects: AdminProject[] }).projects
}

export async function getAdminActivity(jwt: string, limit = 100): Promise<AdminActivity[]> {
  const url = `${FRONTIER_BASE}/api/v2/admin/activity?limit=${encodeURIComponent(String(limit))}`
  const res = await fetchWithTimeout(url, { headers: authHeaders(jwt) })
  if (!res.ok) throw new UserError(res.status, "")
  return ((await res.json()) as { activity: AdminActivity[] }).activity
}
