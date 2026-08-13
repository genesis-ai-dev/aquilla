// Word-metered AI credits. Parallel to the dollar credit ledger: record
// always, enforce only for paid Field / Enterprise orgs.

import {
  type BillingPlan,
  type BillingStatus,
  type WordBlockReason,
  FIELD_PLAN,
  checkWordAllowance,
  periodAllowanceWords,
  periodDaysBetween,
  remainingWords,
  shouldTalkToUs,
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
  hard_cap_words: number | null
}

export interface OrgWordSnapshot {
  plan: BillingPlan
  status: BillingStatus
  periodStart: string | null
  periodEnd: string | null
  wordsUsed: number
  trailingYearWords: number
  addonPacks: number
  includedWords: number
  allowanceWords: number | null
  remaining: number | null
  hardCapWords: number | null
  talkToUs: boolean
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
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
    hard_cap_words: null,
  }
}

export async function readOrgBilling(db: AquillaDb, orgId: number): Promise<OrgBillingRow> {
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
    return {
      ...row,
      plan: (row.plan as BillingPlan) || "none",
      status: (row.status as BillingStatus) || "none",
      addon_packs: Number(row.addon_packs) || 0,
      hard_cap_words: row.hard_cap_words == null ? null : Number(row.hard_cap_words),
    }
  } catch (err) {
    if (isMissingTableError(err)) return emptyBillingRow(orgId)
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

export async function readWordSnapshot(db: AquillaDb, orgId: number): Promise<OrgWordSnapshot> {
  const billing = await readOrgBilling(db, orgId)
  const periodStart = periodStartDate(billing)
  const [wordsUsed, trailingYearWords] = await Promise.all([
    sumWordsSince(db, orgId, periodStart),
    sumWordsSince(db, orgId, nDaysAgoUtc(364)),
  ])
  const allowanceWords = periodAllowanceWords({
    plan: billing.plan,
    addonPacks: billing.addon_packs,
    hardCapWords: billing.hard_cap_words,
  })
  const periodDays = periodDaysBetween(billing.current_period_start, billing.current_period_end)
  return {
    plan: billing.plan,
    status: billing.status,
    periodStart: billing.current_period_start,
    periodEnd: billing.current_period_end,
    wordsUsed,
    trailingYearWords,
    addonPacks: billing.addon_packs,
    includedWords: billing.plan === "field" ? FIELD_PLAN.includedWords : 0,
    allowanceWords,
    remaining: remainingWords(wordsUsed, allowanceWords),
    hardCapWords: billing.hard_cap_words,
    talkToUs: shouldTalkToUs({
      plan: billing.plan,
      periodWords: wordsUsed,
      periodDays,
      trailingYearWords,
    }),
    stripeCustomerId: billing.stripe_customer_id,
    stripeSubscriptionId: billing.stripe_subscription_id,
  }
}

export interface WordGuardResult {
  ok: boolean
  status?: 429
  reason?: WordBlockReason
}

/**
 * Pre-flight word-allowance check. Unpaid orgs always pass (record-only).
 * Paid Field / Enterprise orgs block at their allowance / hard cap.
 * Never throws — degrade to allow if the ledger is missing.
 */
export async function wordGuard(db: AquillaDb, orgId: number): Promise<WordGuardResult> {
  let snapshot: OrgWordSnapshot
  try {
    snapshot = await readWordSnapshot(db, orgId)
  } catch {
    return { ok: true }
  }

  if (snapshot.plan === "none") return { ok: true }

  const check = checkWordAllowance(snapshot.wordsUsed, snapshot.allowanceWords, snapshot.plan)
  if (!check.ok) {
    console.warn(
      `[billing] org ${orgId} over ${check.reason} on plan=${snapshot.plan}`,
      { wordsUsed: snapshot.wordsUsed, allowance: snapshot.allowanceWords },
    )
    return { ok: false, status: 429, reason: check.reason }
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
