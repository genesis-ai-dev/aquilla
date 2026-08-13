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

export function fieldAllowanceWords(addonPacks: number): number {
  return FIELD_PLAN.includedWords + Math.max(0, Math.floor(addonPacks)) * FIELD_PLAN.addonWords
}

export function periodAllowanceWords(args: {
  plan: BillingPlan
  addonPacks: number
  hardCapWords: number | null
}): number | null {
  if (args.plan === "none") return null
  if (args.plan === "enterprise") {
    return args.hardCapWords ?? FIELD_PLAN.talkToUsWordsPerYear
  }
  return fieldAllowanceWords(args.addonPacks)
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
}): boolean {
  if (args.plan === "enterprise") return false
  const annualized = annualizedWords(args.periodWords, args.periodDays)
  const trailing = args.trailingYearWords ?? 0
  return annualized > FIELD_PLAN.talkToUsWordsPerYear || trailing > FIELD_PLAN.talkToUsWordsPerYear
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
