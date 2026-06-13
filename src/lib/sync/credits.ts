/**
 * Client lib for the credits metering endpoints (auth-worker).
 *
 * Mirrors usage.ts pattern: fetchWithTimeout + Authorization header.
 * 403 → null (caller lacks permission); other errors propagate.
 *
 * Spec: docs/superpowers/specs/2026-06-13-org-credits-cost-model.md
 */

import { FRONTIER_BASE } from "../frontier/auth"
import { fetchWithTimeout } from "../frontier/orgs"

/** Per-rail credit breakdown for a time window. */
export interface CreditsWindowBreakdown {
  totalCredits: number
  byRail: {
    llm: number
    agent: number
    tts: number
  }
  agentCredits: number
}

/** Remaining credit allowances (credits left before caps hit). */
export interface CreditsRemaining {
  daily: number
  weekly: number
  agentDaily: number
  agentWeekly: number
}

/** Credit config (caps + markup) for an org. */
export interface OrgCreditConfig {
  markup: number
  agentMarkup: number
  dailyCap: number
  weeklyCap: number
  agentDailyCap: number
  agentWeeklyCap: number
  enforce: boolean
}

/**
 * Shape returned by GET /api/v1/usage/org/:orgId/credits.
 * 403 if caller is not: platform-admin OR (org-maintainer AND cfg.showToOrg).
 */
export interface OrgCredits {
  config: OrgCreditConfig & { showToOrg: boolean }
  day: CreditsWindowBreakdown
  week: CreditsWindowBreakdown
  remaining: CreditsRemaining
}

/** One org row in the platform-admin credits list. Matches the auth-worker
 * `GET /api/v2/admin/credits/orgs` element shape (caps + enforce + showToOrg are
 * nested under `config`, same as the org-facing /credits endpoint). */
export interface AdminOrgCredits {
  orgId: number
  orgName: string | null
  config: OrgCreditConfig & { showToOrg: boolean }
  day: CreditsWindowBreakdown
  week: CreditsWindowBreakdown
}

/** Partial config for PATCH /api/v2/admin/credits/org/:orgId */
export interface CreditConfigPatch {
  markup?: number
  agentMarkup?: number
  dailyCap?: number
  weeklyCap?: number
  agentDailyCap?: number
  agentWeeklyCap?: number
  enforce?: boolean
  showToOrg?: boolean
}

/**
 * Fetch the org credit usage + cap config for the active window (today + rolling 7d).
 *
 * Returns null on 403 — either the caller is not a maintainer, or showToOrg is
 * off for this org. The CreditsPanel uses this to self-hide rather than error.
 */
export async function getOrgCredits(jwt: string, orgId: number): Promise<OrgCredits | null> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v1/usage/org/${encodeURIComponent(orgId)}/credits`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (res.status === 403) return null
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`credits/org failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as OrgCredits
}

/**
 * (Platform-admin only) Fetch per-org credit spend + config for all orgs.
 *
 * Returns null on 403 (caller is not a platform admin).
 */
export async function listOrgCredits(jwt: string): Promise<AdminOrgCredits[] | null> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/admin/credits/orgs`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (res.status === 403) return null
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`admin/credits/orgs failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  // Server wraps the array as { orgs: [...] }.
  return ((await res.json()) as { orgs: AdminOrgCredits[] }).orgs
}

/**
 * (Platform-admin only) Patch the credit config for a specific org.
 * Partial — only supplied fields are updated. Missing fields fall back to
 * platform env defaults (see spec §Config).
 */
export async function setOrgCreditConfig(
  jwt: string,
  orgId: number,
  patch: CreditConfigPatch,
): Promise<void> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/admin/credits/org/${encodeURIComponent(orgId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(patch),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`admin/credits/org PATCH failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
}
