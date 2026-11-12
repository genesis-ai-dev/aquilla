// AQU-2068: the one % meter's data (spec §6). The server sends a tier, a mode
// and a percentage; this module turns that into the one state every meter
// surface renders. It never sees units, cents or credits, so no surface can
// show them (spec R7).

import { FRONTIER_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import type { AiPlanTier } from "./ai-refusal"

export interface AiMeterData {
  orgId: number
  plan: AiPlanTier
  /** `byok` arrives once the org stores its own keys server-side (AQU-2015). */
  mode: "metered" | "unmetered" | "byok"
  /** null = the ledger read failed; never shown as 0%. */
  percentUsed: number | null
  resetsAt: string | null
}

/** At 80% the meter warns; at 100% new AI actions stop (spec §6). */
export const METER_WARNING_PERCENT = 80
export const METER_EXHAUSTED_PERCENT = 100

export type MeterLevel = "ok" | "warning" | "exhausted"

export type MeterView =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "unlimited" }
  | { kind: "byok" }
  | { kind: "metered"; tier: "free" | "team"; percent: number; level: MeterLevel; resetsAt: string | null }

/** `undefined` = still loading, `null` = the read failed. */
export function meterView(data: AiMeterData | null | undefined): MeterView {
  if (data === undefined) return { kind: "loading" }
  if (data === null) return { kind: "unavailable" }
  // Enterprise first: an Enterprise org with its own key is still Unlimited.
  if (data.plan === "enterprise" || data.mode === "unmetered") return { kind: "unlimited" }
  if (data.mode === "byok") return { kind: "byok" }
  if (data.percentUsed === null) return { kind: "unavailable" }
  const percent = Math.max(0, Math.min(100, Math.round(data.percentUsed)))
  const level: MeterLevel = percent >= METER_EXHAUSTED_PERCENT ? "exhausted"
    : percent >= METER_WARNING_PERCENT ? "warning" : "ok"
  return { kind: "metered", tier: data.plan, percent, level, resetsAt: data.resetsAt }
}

export async function getAiMeter(jwt: string, orgId: number): Promise<AiMeterData> {
  const response = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/ai-meter`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!response.ok) throw new Error("AI usage is unavailable.")
  const data = await response.json() as AiMeterData
  if (data.orgId !== orgId) throw new Error("AI usage response mismatch")
  return data
}
