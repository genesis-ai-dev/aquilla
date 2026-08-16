// Word-metered AI credits. Parallel to the dollar credit ledger: record
// always, enforce only for paid Field / Enterprise orgs.

import {
  type BillingPlan,
  type BillingStatus,
  type ResolvedFieldPlan,
  type TargetLaneProject,
  type WordBlockReason,
  FIELD_PLAN,
  checkWordAllowance,
  countDistinctTargetLanes,
  periodAllowanceCredits,
  periodAllowanceWords,
  periodDaysBetween,
  remainingWords,
  shouldTalkToUs,
  wordsToCredits,
} from "./plans"

export type WordRail = "llm" | "agent" | "tts"

export interface OrgBillingRow {
  org_id: number
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan: BillingPlan
  status: BillingStatus
  current_period_start: string | null
  current_period_end: string | null
  addon_packs: number
  complimentary_words: number
  hard_cap_words: number | null
}

export interface OrgBillingOverrides {
  includedCredits: number | null
  billedLanguageCount: number | null
}

export interface OrgWordSnapshot {
  plan: BillingPlan
  status: BillingStatus
  periodStart: string | null
  periodEnd: string | null
  wordsUsed: number
  trailingYearWords: number
  addonPacks: number
  complimentaryWords: number
  includedWords: number
  allowanceWords: number | null
  remaining: number | null
  hardCapWords: number | null
  talkToUs: boolean
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  wordsPerCredit: number
  creditsUsed: number
  complimentaryCredits: number
  includedCredits: number
  allowanceCredits: number
  remainingCredits: number
  languageCount: number
  includedCreditsOverride: number | null
  billedLanguageCountOverride: number | null
}

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("does not exist") || msg.includes("undefined_table")
}

function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function nDaysAgoUtc(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return utcDateKey(d)
}

export function emptyBillingRow(orgId: number): OrgBillingRow {
  return {
    org_id: orgId,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan: "none",
    status: "none",
    current_period_start: null,
    current_period_end: null,
    addon_packs: 0,
    complimentary_words: 0,
    hard_cap_words: null,
  }
}

function normalizeBillingRow(row: OrgBillingRow): OrgBillingRow {
  return {
    ...row,
    plan: (row.plan as BillingPlan) || "none",
    status: (row.status as BillingStatus) || "none",
    addon_packs: Number(row.addon_packs) || 0,
    complimentary_words: Number(row.complimentary_words) || 0,
    hard_cap_words: row.hard_cap_words == null ? null : Number(row.hard_cap_words),
  }
}

export async function readOrgBilling(db: AquillaDb, orgId: number): Promise<OrgBillingRow> {
  try {
    const row = await db
      .prepare(
        `SELECT org_id, stripe_customer_id, stripe_subscription_id, plan, status,
                current_period_start::text, current_period_end::text,
                addon_packs, complimentary_words, hard_cap_words
           FROM org_billing WHERE org_id = ?`,
      )
      .bind(orgId)
      .first<OrgBillingRow>()
    if (!row) return emptyBillingRow(orgId)
    return normalizeBillingRow(row)
  } catch (err) {
    if (isMissingTableError(err)) return emptyBillingRow(orgId)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("complimentary_words") || msg.includes("undefined_column")) {
      try {
        const row = await db
          .prepare(
            `SELECT org_id, stripe_customer_id, stripe_subscription_id, plan, status,
                    current_period_start::text, current_period_end::text,
                    addon_packs, hard_cap_words
               FROM org_billing WHERE org_id = ?`,
          )
          .bind(orgId)
          .first<OrgBillingRow>()
        if (!row) return emptyBillingRow(orgId)
        return normalizeBillingRow({ ...row, complimentary_words: 0 })
      } catch (inner) {
        if (isMissingTableError(inner)) return emptyBillingRow(orgId)
        console.error("[billing] readOrgBilling fallback error:", inner)
        return emptyBillingRow(orgId)
      }
    }
    console.error("[billing] readOrgBilling error:", err)
    return emptyBillingRow(orgId)
  }
}

export async function recordWords(
  db: AquillaDb,
  orgId: number,
  userId: number,
  rail: WordRail,
  words: number,
): Promise<void> {
  if (!Number.isFinite(words) || words <= 0) return
  const today = utcDateKey()
  try {
    await db
      .prepare(
        `INSERT INTO org_word_usage_daily (org_id, user_id, date_utc, rail, words)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, user_id, date_utc, rail)
         DO UPDATE SET words = org_word_usage_daily.words + EXCLUDED.words`,
      )
      .bind(orgId, userId, today, rail, Math.round(words))
      .run()
  } catch (err) {
    if (isMissingTableError(err)) return
    console.error("[billing] recordWords error (ignoring):", err)
  }
}

async function sumWordsSince(db: AquillaDb, orgId: number, since: string): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(words), 0) AS words
           FROM org_word_usage_daily
          WHERE org_id = ? AND date_utc >= ?`,
      )
      .bind(orgId, since)
      .first<{ words: number }>()
    return Number(row?.words) || 0
  } catch (err) {
    if (isMissingTableError(err)) return 0
    console.error("[billing] sumWordsSince error:", err)
    return 0
  }
}

function periodStartDate(billing: OrgBillingRow): string {
  if (billing.current_period_start) {
    const parsed = Date.parse(billing.current_period_start)
    if (Number.isFinite(parsed)) return utcDateKey(new Date(parsed))
  }
  return nDaysAgoUtc(FIELD_PLAN.intervalDays - 1)
}

export async function resetWordUsage(db: AquillaDb, orgId: number, since?: string): Promise<number> {
  try {
    const stmt = since
      ? db.prepare(`DELETE FROM org_word_usage_daily WHERE org_id = ? AND date_utc >= ?`).bind(orgId, since)
      : db.prepare(`DELETE FROM org_word_usage_daily WHERE org_id = ?`).bind(orgId)
    const result = await stmt.run()
    return Number(result.meta?.changes ?? 0)
  } catch (err) {
    if (isMissingTableError(err)) return 0
    throw err
  }
}

function parseLaneList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
    } catch {
      return []
    }
  }
  return []
}

export async function readOrgBillingOverrides(db: AquillaDb, orgId: number): Promise<OrgBillingOverrides> {
  const empty: OrgBillingOverrides = { includedCredits: null, billedLanguageCount: null }
  try {
    const row = await db
      .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
      .bind(orgId)
      .first<{ settings: string }>()
    if (!row?.settings) return empty
    const parsed = JSON.parse(row.settings) as Record<string, unknown>
    const billing = parsed.billing
    if (!billing || typeof billing !== "object" || Array.isArray(billing)) return empty
    const blob = billing as Record<string, unknown>
    return {
      includedCredits: typeof blob.includedCredits === "number" ? Math.floor(blob.includedCredits) : null,
      billedLanguageCount:
        typeof blob.billedLanguageCount === "number" ? Math.max(0, Math.floor(blob.billedLanguageCount)) : null,
    }
  } catch {
    return empty
  }
}

export async function writeOrgBillingOverrides(
  db: AquillaDb,
  orgId: number,
  patch: Partial<OrgBillingOverrides>,
): Promise<void> {
  const current = await readOrgBillingOverrides(db, orgId)
  const next: OrgBillingOverrides = {
    includedCredits: patch.includedCredits === undefined ? current.includedCredits : patch.includedCredits,
    billedLanguageCount:
      patch.billedLanguageCount === undefined ? current.billedLanguageCount : patch.billedLanguageCount,
  }
  try {
    const row = await db
      .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
      .bind(orgId)
      .first<{ settings: string }>()
    const parsed = row?.settings ? (JSON.parse(row.settings) as Record<string, unknown>) : {}
    const billing =
      parsed.billing && typeof parsed.billing === "object" && !Array.isArray(parsed.billing)
        ? { ...(parsed.billing as Record<string, unknown>) }
        : {}
    if (next.includedCredits == null) delete billing.includedCredits
    else billing.includedCredits = next.includedCredits
    if (next.billedLanguageCount == null) delete billing.billedLanguageCount
    else billing.billedLanguageCount = next.billedLanguageCount
    const settings = JSON.stringify({ ...parsed, billing })
    await db
      .prepare(
        `INSERT INTO org_settings (org_id, settings, version, updated_at)
         VALUES (?, ?, 1, now())
         ON CONFLICT (org_id) DO UPDATE SET
           settings = EXCLUDED.settings,
           updated_at = now()`,
      )
      .bind(orgId, settings)
      .run()
  } catch (err) {
    if (isMissingTableError(err)) return
    console.error("[billing] writeOrgBillingOverrides error:", err)
  }
}

export async function countOrgTargetLanes(db: AquillaDb, orgId: number): Promise<number> {
  try {
    const { results } = await db
      .prepare(
        `SELECT ps.target_language,
                ps.target_lanes,
                (ps.settings::jsonb)->'archivedLanes' AS archived_lanes
           FROM project_settings ps
           JOIN projects p ON p.id = ps.project_id
          WHERE p.org_id = ? AND p.archived_at IS NULL`,
      )
      .bind(orgId)
      .all<{ target_language: string | null; target_lanes: unknown; archived_lanes: unknown }>()
    const projects: TargetLaneProject[] = (results ?? []).map((row) => ({
      targetLanguage: row.target_language,
      targetLanes: parseLaneList(row.target_lanes),
      archivedLanes: parseLaneList(row.archived_lanes),
    }))
    return countDistinctTargetLanes(projects)
  } catch (err) {
    if (isMissingTableError(err)) return 0
    console.error("[billing] countOrgTargetLanes error:", err)
    return 0
  }
}

export async function readWordSnapshot(
  db: AquillaDb,
  orgId: number,
  catalog?: Pick<
    ResolvedFieldPlan,
    | "includedWords"
    | "addonWords"
    | "talkToUsWordsPerYear"
    | "wordsPerCredit"
    | "exploreCreditsPerCycle"
    | "fieldCreditsPerCycle"
    | "addonCredits"
    | "enterpriseCreditsPerLanguagePerYear"
  >,
): Promise<OrgWordSnapshot> {
  const billing = await readOrgBilling(db, orgId)
  const periodStart = periodStartDate(billing)
  const [wordsUsed, trailingYearWords, overrides, autoLanguageCount] = await Promise.all([
    sumWordsSince(db, orgId, periodStart),
    sumWordsSince(db, orgId, nDaysAgoUtc(364)),
    readOrgBillingOverrides(db, orgId),
    countOrgTargetLanes(db, orgId),
  ])
  const wordsPerCredit = catalog?.wordsPerCredit ?? 100
  const languageCount = overrides.billedLanguageCount ?? autoLanguageCount
  const includedWords = catalog?.includedWords ?? FIELD_PLAN.includedWords
  const addonWords = catalog?.addonWords ?? FIELD_PLAN.addonWords
  const allowanceWords = periodAllowanceWords({
    plan: billing.plan,
    addonPacks: billing.addon_packs,
    hardCapWords: billing.hard_cap_words,
    complimentaryWords: billing.complimentary_words,
    includedWords,
    addonWords,
    languageCount,
    includedCreditsOverride: overrides.includedCredits,
    wordsPerCredit,
    exploreCreditsPerCycle: catalog?.exploreCreditsPerCycle,
    fieldCreditsPerCycle: catalog?.fieldCreditsPerCycle,
    enterpriseCreditsPerLanguagePerYear: catalog?.enterpriseCreditsPerLanguagePerYear,
  })
  const complimentaryCredits = wordsToCredits(billing.complimentary_words, wordsPerCredit)
  const allowanceCredits = periodAllowanceCredits({
    plan: billing.plan,
    addonPacks: billing.addon_packs,
    languageCount,
    complimentaryCredits,
    includedCreditsOverride: overrides.includedCredits,
    exploreCreditsPerCycle: catalog?.exploreCreditsPerCycle,
    fieldCreditsPerCycle: catalog?.fieldCreditsPerCycle,
    fieldAddonCredits: catalog?.addonCredits,
    enterpriseCreditsPerLanguagePerYear: catalog?.enterpriseCreditsPerLanguagePerYear,
  })
  const creditsUsed = wordsToCredits(wordsUsed, wordsPerCredit)
  const periodDays = periodDaysBetween(billing.current_period_start, billing.current_period_end)
  const resolvedIncludedCredits =
    billing.plan === "field"
      ? (catalog?.fieldCreditsPerCycle ?? wordsToCredits(includedWords, wordsPerCredit))
      : billing.plan === "enterprise"
        ? allowanceCredits - complimentaryCredits
        : (catalog?.exploreCreditsPerCycle ?? 100)
  return {
    plan: billing.plan,
    status: billing.status,
    periodStart: billing.current_period_start,
    periodEnd: billing.current_period_end,
    wordsUsed,
    trailingYearWords,
    addonPacks: billing.addon_packs,
    complimentaryWords: billing.complimentary_words,
    includedWords: billing.plan === "field" ? includedWords : creditsToWordsForPlan(billing.plan, catalog, wordsPerCredit),
    allowanceWords,
    remaining: remainingWords(wordsUsed, allowanceWords),
    hardCapWords: billing.hard_cap_words,
    talkToUs: shouldTalkToUs({
      plan: billing.plan,
      periodWords: wordsUsed,
      periodDays,
      trailingYearWords,
      threshold: catalog?.talkToUsWordsPerYear,
    }),
    stripeCustomerId: billing.stripe_customer_id,
    stripeSubscriptionId: billing.stripe_subscription_id,
    wordsPerCredit,
    creditsUsed,
    complimentaryCredits,
    includedCredits: Math.max(0, resolvedIncludedCredits),
    allowanceCredits,
    remainingCredits: Math.max(0, allowanceCredits - creditsUsed),
    languageCount,
    includedCreditsOverride: overrides.includedCredits,
    billedLanguageCountOverride: overrides.billedLanguageCount,
  }
}

function creditsToWordsForPlan(
  plan: BillingPlan,
  catalog: Pick<ResolvedFieldPlan, "exploreCreditsPerCycle" | "fieldCreditsPerCycle"> | undefined,
  wordsPerCredit: number,
): number {
  if (plan === "field") return (catalog?.fieldCreditsPerCycle ?? 1000) * wordsPerCredit
  if (plan === "enterprise") return 0
  return (catalog?.exploreCreditsPerCycle ?? 100) * wordsPerCredit
}

export interface WordGuardResult {
  ok: boolean
  status?: 429
  reason?: WordBlockReason
}

/**
 * Pre-flight word-allowance check. Enforcement is off until checkout launches:
 * we still record usage and compute the allowance, but never block.
 */
export async function wordGuard(db: AquillaDb, orgId: number): Promise<WordGuardResult> {
  try {
    const snapshot = await readWordSnapshot(db, orgId)
    const check = checkWordAllowance(snapshot.wordsUsed, snapshot.allowanceWords, snapshot.plan)
    if (!check.ok) {
      console.warn(
        `[billing] org ${orgId} over ${check.reason} on plan=${snapshot.plan} (log-only)`,
        { wordsUsed: snapshot.wordsUsed, allowance: snapshot.allowanceWords },
      )
    }
  } catch {
    return { ok: true }
  }
  return { ok: true }
}

export function wordCapMessage(reason: WordBlockReason | undefined): string {
  if (reason === "hard_cap") {
    return "This organization has reached its Enterprise usage cap. Talk to us to raise it."
  }
  return "This organization has used its Field Plan word allowance for this period. Buy a 100,000-word add-on to continue."
}

export function wordCapBody(reason: WordBlockReason | undefined): {
  error: "word_allowance_exceeded"
  reason: WordBlockReason | undefined
  message: string
} {
  return { error: "word_allowance_exceeded", reason, message: wordCapMessage(reason) }
}
