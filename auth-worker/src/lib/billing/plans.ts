// Field Plan pricing — mirrored from src/lib/billing/plans.ts.
// Keep the two copies in lockstep (same pattern as credits.ts).

export const WORDS_PER_CREDIT_DEFAULT = 100
export const CYCLES_PER_YEAR = 13

export const TIER_CREDITS = {
  explore: { creditsPerCycle: 100 },
  field: { creditsPerCycle: 1_000 },
  enterprise: { creditsPerLanguagePerYear: 10_000 },
} as const

export const FIELD_PLAN = {
  id: "field",
  name: "Field Plan",
  intervalDays: 28,
  priceCents: 50_000,
  includedWords: TIER_CREDITS.field.creditsPerCycle * WORDS_PER_CREDIT_DEFAULT,
  addonWords: TIER_CREDITS.field.creditsPerCycle * WORDS_PER_CREDIT_DEFAULT,
  addonPriceCents: 20_000,
  talkToUsWordsPerYear: 25_000_000,
} as const

export type BillingPlan = "none" | "explore" | "field" | "enterprise"
export type ResolvedBillingPlan = "explore" | "field" | "enterprise"

export type BillingStatus =
  | "none"
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"

export function wordsToCredits(words: number, wordsPerCredit: number = WORDS_PER_CREDIT_DEFAULT): number {
  const rate = wordsPerCredit > 0 ? wordsPerCredit : WORDS_PER_CREDIT_DEFAULT
  const n = Math.max(0, Math.floor(words))
  if (n <= 0) return 0
  return Math.ceil(n / rate)
}

export function creditsToWords(credits: number, wordsPerCredit: number = WORDS_PER_CREDIT_DEFAULT): number {
  const rate = wordsPerCredit > 0 ? wordsPerCredit : WORDS_PER_CREDIT_DEFAULT
  return Math.max(0, Math.floor(credits)) * rate
}

export function normalizeBillingPlan(plan: BillingPlan): ResolvedBillingPlan {
  if (plan === "field" || plan === "enterprise" || plan === "explore") return plan
  return "explore"
}

export function enterpriseCycleCredits(
  languageCount: number,
  creditsPerLanguagePerYear: number = TIER_CREDITS.enterprise.creditsPerLanguagePerYear,
): number {
  const langs = Math.max(0, Math.floor(languageCount))
  const perYear = Math.max(0, Math.floor(creditsPerLanguagePerYear))
  return Math.round(perYear / CYCLES_PER_YEAR) * langs
}

export function periodAllowanceCredits(args: {
  plan: BillingPlan
  addonPacks: number
  languageCount: number
  complimentaryCredits?: number
  includedCreditsOverride?: number | null
  exploreCreditsPerCycle?: number
  fieldCreditsPerCycle?: number
  fieldAddonCredits?: number
  enterpriseCreditsPerLanguagePerYear?: number
}): number {
  const extra = Math.max(0, Math.floor(args.complimentaryCredits ?? 0))
  if (typeof args.includedCreditsOverride === "number" && Number.isFinite(args.includedCreditsOverride)) {
    return Math.max(0, Math.floor(args.includedCreditsOverride)) + extra
  }
  const resolved = normalizeBillingPlan(args.plan)
  if (resolved === "explore") {
    return (args.exploreCreditsPerCycle ?? TIER_CREDITS.explore.creditsPerCycle) + extra
  }
  if (resolved === "enterprise") {
    return (
      enterpriseCycleCredits(
        args.languageCount,
        args.enterpriseCreditsPerLanguagePerYear ?? TIER_CREDITS.enterprise.creditsPerLanguagePerYear,
      ) + extra
    )
  }
  const included = args.fieldCreditsPerCycle ?? TIER_CREDITS.field.creditsPerCycle
  const addon = args.fieldAddonCredits ?? TIER_CREDITS.field.creditsPerCycle
  return included + Math.max(0, Math.floor(args.addonPacks)) * addon + extra
}

export interface TargetLaneProject {
  targetLanguage?: string | null
  targetLanes?: readonly string[] | null
  archivedLanes?: readonly string[] | null
}

function normalizeLaneTag(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase()
}

export function countDistinctTargetLanes(projects: readonly TargetLaneProject[]): number {
  const tags = new Set<string>()
  for (const project of projects) {
    const archived = new Set((project.archivedLanes ?? []).map(normalizeLaneTag).filter(Boolean))
    const primary = normalizeLaneTag(project.targetLanguage)
    if (primary) tags.add(primary)
    for (const lane of project.targetLanes ?? []) {
      const tag = normalizeLaneTag(lane)
      if (!tag || archived.has(tag)) continue
      tags.add(tag)
    }
  }
  return tags.size
}

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
  languageCount?: number
  includedCreditsOverride?: number | null
  wordsPerCredit?: number
  exploreCreditsPerCycle?: number
  fieldCreditsPerCycle?: number
  enterpriseCreditsPerLanguagePerYear?: number
}): number {
  const extra = Math.max(0, Math.floor(args.complimentaryWords ?? 0))
  const rate = args.wordsPerCredit ?? WORDS_PER_CREDIT_DEFAULT
  if (typeof args.includedCreditsOverride === "number" && Number.isFinite(args.includedCreditsOverride)) {
    return creditsToWords(args.includedCreditsOverride, rate) + extra
  }
  if (args.plan === "enterprise" && args.hardCapWords != null) {
    return args.hardCapWords + extra
  }
  const fieldCredits =
    args.fieldCreditsPerCycle ??
    (args.includedWords != null ? wordsToCredits(args.includedWords, rate) : TIER_CREDITS.field.creditsPerCycle)
  const addonCredits =
    args.addonWords != null ? wordsToCredits(args.addonWords, rate) : TIER_CREDITS.field.creditsPerCycle
  return (
    creditsToWords(
      periodAllowanceCredits({
        plan: args.plan,
        addonPacks: args.addonPacks,
        languageCount: args.languageCount ?? 1,
        exploreCreditsPerCycle: args.exploreCreditsPerCycle,
        fieldCreditsPerCycle: fieldCredits,
        fieldAddonCredits: addonCredits,
        enterpriseCreditsPerLanguagePerYear: args.enterpriseCreditsPerLanguagePerYear,
      }),
      rate,
    ) + extra
  )
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
  wordsPerCredit?: number
  exploreCreditsPerCycle?: number
  fieldCreditsPerCycle?: number
  addonCredits?: number
  enterpriseCreditsPerLanguagePerYear?: number
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
  wordsPerCredit: number
  exploreCreditsPerCycle: number
  fieldCreditsPerCycle: number
  addonCredits: number
  enterpriseCreditsPerLanguagePerYear: number
}

export function resolveFieldPlan(
  stored: FieldPlanSettings | undefined,
  env: { STRIPE_PRICE_FIELD?: string; STRIPE_PRICE_ADDON?: string },
): ResolvedFieldPlan {
  const wordsPerCredit =
    typeof stored?.wordsPerCredit === "number" && stored.wordsPerCredit > 0
      ? Math.floor(stored.wordsPerCredit)
      : WORDS_PER_CREDIT_DEFAULT
  const fieldCreditsPerCycle =
    typeof stored?.fieldCreditsPerCycle === "number"
      ? Math.max(0, Math.floor(stored.fieldCreditsPerCycle))
      : typeof stored?.includedWords === "number"
        ? wordsToCredits(stored.includedWords, wordsPerCredit)
        : TIER_CREDITS.field.creditsPerCycle
  const addonCredits =
    typeof stored?.addonCredits === "number"
      ? Math.max(0, Math.floor(stored.addonCredits))
      : typeof stored?.addonWords === "number"
        ? wordsToCredits(stored.addonWords, wordsPerCredit)
        : TIER_CREDITS.field.creditsPerCycle
  const exploreCreditsPerCycle =
    typeof stored?.exploreCreditsPerCycle === "number"
      ? Math.max(0, Math.floor(stored.exploreCreditsPerCycle))
      : TIER_CREDITS.explore.creditsPerCycle
  const enterpriseCreditsPerLanguagePerYear =
    typeof stored?.enterpriseCreditsPerLanguagePerYear === "number"
      ? Math.max(0, Math.floor(stored.enterpriseCreditsPerLanguagePerYear))
      : TIER_CREDITS.enterprise.creditsPerLanguagePerYear
  return {
    name: FIELD_PLAN.name,
    intervalDays: stored?.intervalDays ?? FIELD_PLAN.intervalDays,
    priceCents: stored?.priceCents ?? FIELD_PLAN.priceCents,
    includedWords: creditsToWords(fieldCreditsPerCycle, wordsPerCredit),
    addonWords: creditsToWords(addonCredits, wordsPerCredit),
    addonPriceCents: stored?.addonPriceCents ?? FIELD_PLAN.addonPriceCents,
    talkToUsWordsPerYear: stored?.talkToUsWordsPerYear ?? FIELD_PLAN.talkToUsWordsPerYear,
    stripePriceField: stored?.stripePriceField?.trim() || env.STRIPE_PRICE_FIELD?.trim() || null,
    stripePriceAddon: stored?.stripePriceAddon?.trim() || env.STRIPE_PRICE_ADDON?.trim() || null,
    wordsPerCredit,
    exploreCreditsPerCycle,
    fieldCreditsPerCycle,
    addonCredits,
    enterpriseCreditsPerLanguagePerYear,
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
