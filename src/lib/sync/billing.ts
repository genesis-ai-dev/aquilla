/**
 * Client lib for org billing (auth-worker Field Plan).
 *
 * Maintainer+ only. 403 → null so the settings page can hide the subscribe
 * controls for viewers without throwing.
 */

import { FRONTIER_BASE } from "../frontier/auth"
import { fetchWithTimeout } from "../frontier/orgs"
import type { BillingPlan, BillingStatus } from "@/lib/billing/plans"

export interface OrgBilling {
  plan: BillingPlan
  status: BillingStatus
  periodStart: string | null
  periodEnd: string | null
  wordsUsed: number
  trailingYearWords: number
  addonPacks: number
  includedWords: number
  allowanceWords: number | null
  remainingWords: number | null
  hardCapWords: number | null
  talkToUs: boolean
  canSubscribe: boolean
  canBuyAddon: boolean
  canManage: boolean
  stripeConfigured: boolean
  fieldPlan: {
    name: string
    intervalDays: number
    priceCents: number
    includedWords: number
    addonWords: number
    addonPriceCents: number
    talkToUsWordsPerYear: number
  }
}

export async function getOrgBilling(jwt: string, orgId: number): Promise<OrgBilling | null> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/billing`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (res.status === 403) return null
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`billing failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as OrgBilling
}

export async function startBillingCheckout(
  jwt: string,
  orgId: number,
  kind: "field" | "addon",
  packs = 1,
): Promise<string> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/billing/checkout`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind, packs }),
    },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new Error(body.message ?? body.error ?? `Checkout failed (${res.status})`)
  }
  const json = (await res.json()) as { url?: string }
  if (!json.url) throw new Error("Checkout session missing URL")
  return json.url
}

export async function startBillingPortal(jwt: string, orgId: number): Promise<string> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/billing/portal`,
    { method: "POST", headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new Error(body.message ?? body.error ?? `Portal failed (${res.status})`)
  }
  const json = (await res.json()) as { url?: string }
  if (!json.url) throw new Error("Portal session missing URL")
  return json.url
}
