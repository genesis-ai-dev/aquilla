// AQU-2068: the one client reader for an AI refusal (spec §5.3). Every AI call
// site hands its failed response here instead of string-matching 402/429
// bodies of its own. It keys on the server's stable `error` reason from
// db/shared/ai-entitlement.ts, plus the legacy allowance codes the older
// guards still send until T5–T8 move every path onto the one check.

import { t } from "@/lib/i18n/standalone"

export type AiRefusalReason = "ai_allowance_exhausted" | "ai_spend_ceiling_reached"
export type AiPlanTier = "free" | "team" | "enterprise"

export interface AiRefusal {
  reason: AiRefusalReason
  tier?: AiPlanTier
  resetsAt?: string
  canUpgrade: boolean
  canByok: boolean
}

/** Pre-T5 guards refuse the allowance with 429 and these codes. */
const LEGACY_ALLOWANCE_CODES = new Set([
  "credit_cap_exceeded", "weekly_ai_allowance_exhausted", "word_allowance_exceeded",
])
const TIERS = new Set<string>(["free", "team", "enterprise"])

function bodyObject(body: unknown): Record<string, unknown> | null {
  if (typeof body === "string") {
    try { return bodyObject(JSON.parse(body)) } catch { return null }
  }
  return body && typeof body === "object" ? body as Record<string, unknown> : null
}

/** The refusal in a failed AI response, or null when it is some other failure
 *  (a rate limit, a missing house key, a provider error). */
export function parseAiRefusal(status: number, body: unknown): AiRefusal | null {
  const parsed = bodyObject(body)
  const code = typeof parsed?.error === "string" ? parsed.error : ""
  if (code === "ai_spend_ceiling_reached") return { reason: code, canUpgrade: false, canByok: false }
  // 402 IS the allowance contract, whatever its body says.
  if (code !== "ai_allowance_exhausted" && !LEGACY_ALLOWANCE_CODES.has(code) && status !== 402) return null
  const tier = typeof parsed?.tier === "string" && TIERS.has(parsed.tier) ? parsed.tier as AiPlanTier : undefined
  return {
    reason: "ai_allowance_exhausted",
    ...(tier ? { tier } : {}),
    ...(typeof parsed?.resetsAt === "string" ? { resetsAt: parsed.resetsAt } : {}),
    canUpgrade: parsed?.canUpgrade === true,
    canByok: parsed?.canByok === true,
  }
}

export class AiRefusalError extends Error {
  readonly refusal: AiRefusal
  constructor(refusal: AiRefusal) {
    super(aiRefusalMessage(refusal))
    this.name = "AiRefusalError"
    this.refusal = refusal
  }
}

/** Plain words for the user. Never an amount: only what stopped and when it
 *  comes back (spec R7). Every allowance message starts with the same
 *  sentence, so `isAiAllowanceMessage` can place it after it was rethrown. */
export function aiRefusalMessage(refusal: AiRefusal): string {
  if (refusal.reason === "ai_spend_ceiling_reached") return t("billing.refusal.ceiling")
  const used = t("billing.refusal.allowance")
  const date = refusal.resetsAt ? new Date(refusal.resetsAt) : null
  if (!date || Number.isNaN(date.getTime())) return used
  return `${used} ${t("billing.refusal.resets", { day: date.toLocaleDateString(undefined, { weekday: "long" }) })}`
}

/** True for an allowance refusal seen only as text: our own message, or a
 *  raw `… failed (402): {"error":…}` body that was folded into a string. */
export function isAiAllowanceMessage(message: string): boolean {
  if (message.startsWith(t("billing.refusal.allowance"))) return true
  const brace = message.indexOf("{")
  return brace >= 0 && parseAiRefusal(0, message.slice(brace))?.reason === "ai_allowance_exhausted"
}

type Listener = (refusal: AiRefusal) => void
const listeners = new Set<Listener>()

/** Meters subscribe so a refusal anywhere flips them to 100% at once. */
export function onAiRefusal(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Parse a failed response; when the allowance refused it, tell the meters and
 *  return the error to throw: `const e = aiRefusalError(s, b); if (e) throw e`.
 *  The platform ceiling is left to each site's existing 503 handling: it is
 *  our limit, not the workspace's, and no meter should move for it. */
export function aiRefusalError(status: number, body: unknown): AiRefusalError | null {
  const refusal = parseAiRefusal(status, body)
  if (refusal?.reason !== "ai_allowance_exhausted") return null
  for (const listener of listeners) listener(refusal)
  return new AiRefusalError(refusal)
}
