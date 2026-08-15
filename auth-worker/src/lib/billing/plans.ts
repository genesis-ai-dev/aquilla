// Field Plan pricing — mirrored from src/lib/billing/plans.ts.
// Keep the two copies in lockstep (same pattern as credits.ts).

export const FIELD_PLAN = {
  id: "field",
  name: "Field Plan",
  intervalDays: 28,
  priceCents: 50_000,
  includedWords: 100_000,
  addonWords: 100_000,
  addonPriceCents: 20_000,
  talkToUsWordsPerYear: 25_000_000,
} as const

export type BillingPlan = "none" | "field" | "enterprise"

export type BillingStatus =
  | "none"
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"

export function fieldAllowanceWords(
  addonPacks: number,
  includedWords: number = FIELD_PLAN.includedWords,
  addonWords: number = FIELD_PLAN.addonWords,
): number {
  return includedWords + Math.max(0, Math.floor(addonPacks)) * addonWords
}

export function periodAllowanceWords(args: {
  plan: BillingPlan
  addonPacks: number
  hardCapWords: number | null
  complimentaryWords?: number
  includedWords?: number
  addonWords?: number
}): number | null {
  const extra = Math.max(0, Math.floor(args.complimentaryWords ?? 0))
  if (args.plan === "none") return null
  if (args.plan === "enterprise") {
    return (args.hardCapWords ?? FIELD_PLAN.talkToUsWordsPerYear) + extra
  }
  return fieldAllowanceWords(args.addonPacks, args.includedWords, args.addonWords) + extra
}

export interface FieldPlanSettings {
  priceCents?: number
  includedWords?: number
  addonWords?: number
  addonPriceCents?: number
  talkToUsWordsPerYear?: number
  intervalDays?: number
  stripePriceField?: string
  stripePriceAddon?: string
}

export interface ResolvedFieldPlan {
  name: string
  intervalDays: number
  priceCents: number
  includedWords: number
  addonWords: number
  addonPriceCents: number
  talkToUsWordsPerYear: number
  stripePriceField: string | null
  stripePriceAddon: string | null
}

export function resolveFieldPlan(
  stored: FieldPlanSettings | undefined,
  env: { STRIPE_PRICE_FIELD?: string; STRIPE_PRICE_ADDON?: string },
): ResolvedFieldPlan {
  return {
    name: FIELD_PLAN.name,
    intervalDays: stored?.intervalDays ?? FIELD_PLAN.intervalDays,
    priceCents: stored?.priceCents ?? FIELD_PLAN.priceCents,
    includedWords: stored?.includedWords ?? FIELD_PLAN.includedWords,
    addonWords: stored?.addonWords ?? FIELD_PLAN.addonWords,
    addonPriceCents: stored?.addonPriceCents ?? FIELD_PLAN.addonPriceCents,
    talkToUsWordsPerYear: stored?.talkToUsWordsPerYear ?? FIELD_PLAN.talkToUsWordsPerYear,
    stripePriceField: stored?.stripePriceField?.trim() || env.STRIPE_PRICE_FIELD?.trim() || null,
    stripePriceAddon: stored?.stripePriceAddon?.trim() || env.STRIPE_PRICE_ADDON?.trim() || null,
  }
}

export function remainingWords(used: number, allowance: number | null): number | null {
  if (allowance == null) return null
  return Math.max(0, allowance - used)
}

export function annualizedWords(periodWords: number, periodDays: number): number {
  if (periodDays <= 0) return 0
  return Math.round((periodWords / periodDays) * 365)
}

export function shouldTalkToUs(args: {
  plan: BillingPlan
  periodWords: number
  periodDays: number
  trailingYearWords?: number
  threshold?: number
}): boolean {
  if (args.plan === "enterprise") return false
  const limit = args.threshold ?? FIELD_PLAN.talkToUsWordsPerYear
  const annualized = annualizedWords(args.periodWords, args.periodDays)
  const trailing = args.trailingYearWords ?? 0
  return annualized > limit || trailing > limit
}

export type WordBlockReason = "allowance" | "hard_cap"

export function checkWordAllowance(
  used: number,
  allowance: number | null,
  plan: BillingPlan,
): { ok: boolean; reason?: WordBlockReason } {
  if (allowance == null) return { ok: true }
  if (used < allowance) return { ok: true }
  return { ok: false, reason: plan === "enterprise" ? "hard_cap" : "allowance" }
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

export function periodDaysBetween(
  startIso: string | null,
  endIso: string | null,
  fallback = FIELD_PLAN.intervalDays,
): number {
  if (!startIso || !endIso) return fallback
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallback
  return Math.max(1, Math.round((end - start) / 86_400_000))
}

export function isPaidStatus(status: BillingStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due"
}
