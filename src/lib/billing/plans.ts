// Field Plan pricing — the self-serve dial from the Aquilla pricing model.
//
// $500 / 4 weeks includes 100,000 AI words. Each extra 100,000-word pack
// in the same period is $200. Past 25M words/year the deal routes to
// "talk to us" (Enterprise). Enterprise pricing is out of scope; Enterprise
// orgs only get a hard usage cap.

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

/** Paid allowance for the current period. `null` = no paid cap (plan none). */
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

export function formatWordCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n)
}

export function formatUsdFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    cents / 100,
  )
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

export function periodDaysBetween(startIso: string | null, endIso: string | null, fallback = FIELD_PLAN.intervalDays): number {
  if (!startIso || !endIso) return fallback
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallback
  return Math.max(1, Math.round((end - start) / 86_400_000))
}
