// Client lib for the usage metering endpoints (auth-worker).
//
// Mirrors the assignments.ts pattern: fetchWithTimeout + Authorization header.
// No pricing is surfaced; these are raw counts and seconds only.

import { FRONTIER_BASE } from "../frontier/auth"
import { fetchWithTimeout } from "../frontier/orgs"

/** One day in the 7-day history returned by /api/v1/usage/me. */
export interface UsageDay {
  date: string
  audioSeconds: number
  ttsRequests: number
  llmRequests: number
}

/** Shape returned by GET /api/v1/usage/me (auth-worker, JWT-authed). */
export interface MyUsage {
  today: {
    audioSeconds: number
    ttsRequests: number
    llmRequests: number
  }
  history: UsageDay[]
}

/** Per-member row in the org usage rollup. */
export interface OrgMemberUsage {
  userId: number
  username: string | null
  audioSeconds: number
  ttsRequests: number
  llmRequests: number
}

/** Shape returned by GET /api/v1/usage/org/:orgId (maintainer-gated → 403).
 * Field is `orgTotal` to match the auth-worker `OrgUsageResponse`. */
export interface OrgUsage {
  orgTotal: {
    audioSeconds: number
    ttsRequests: number
    llmRequests: number
  }
  members: OrgMemberUsage[]
}

/**
 * Fetch the caller's personal usage rollup (today + 7-day history).
 * JWT is the active session token from useFrontierSession.
 */
export async function getMyUsage(jwt: string): Promise<MyUsage> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v1/usage/me`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`usage/me failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as MyUsage
}

/**
 * Fetch the org-wide per-member usage rollup. Returns null on 403 (caller is
 * not a maintainer) so the UI can silently hide rather than show an error.
 * Throws on other non-OK statuses (transient network failures, etc.).
 */
export async function getOrgUsage(jwt: string, orgId: number): Promise<OrgUsage | null> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v1/usage/org/${encodeURIComponent(orgId)}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (res.status === 403) return null
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`usage/org failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as OrgUsage
}
