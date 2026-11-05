/** Version the actual disclosure/approval contract, not a browser-wide toggle. */
export const ANALYTICS_DISCLOSURE_VERSION = "2026-11-04"
export const ANALYTICS_CONSENT_KEY = "privacy.analytics.v1"
export interface AnalyticsDecision {
  allowed: boolean
  disclosureVersion: string
  decidedAt: string
  revision: string
  source: "signup" | "settings"
}
export interface AnalyticsConsentResponse {
  accountId: string
  decision: AnalyticsDecision | null
}
export function parseAnalyticsDecision(value: unknown): AnalyticsDecision | null {
  if (!value || typeof value !== "object") return null
  const v = value as Partial<AnalyticsDecision>
  if (typeof v.allowed !== "boolean" || v.disclosureVersion !== ANALYTICS_DISCLOSURE_VERSION ||
      typeof v.decidedAt !== "string" || !Number.isFinite(Date.parse(v.decidedAt)) ||
      typeof v.revision !== "string" || !v.revision || (v.source !== "signup" && v.source !== "settings")) return null
  return v as AnalyticsDecision
}
