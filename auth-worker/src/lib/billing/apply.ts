// Project Stripe webhook / checkout events onto org_billing.
// Idempotent on stripe_event_id. Period rollover zeroes addon_packs.

import type { BillingPlan, BillingStatus } from "./plans"
import { emptyBillingRow, type OrgBillingRow } from "./words"

// Mutation paths must never turn a database failure into an empty billing row.
async function readOrgBilling(db: AquillaDb, orgId: number): Promise<OrgBillingRow> {
  const row = await db.prepare(`SELECT org_id, stripe_customer_id,
    stripe_subscription_id, plan, status, current_period_start::text,
    current_period_end::text, addon_packs, complimentary_words, hard_cap_words
    FROM org_billing WHERE org_id = ?`).bind(orgId).first<OrgBillingRow>()
  if (!row) return emptyBillingRow(orgId)
  return { ...row, addon_packs: Number(row.addon_packs) || 0,
    complimentary_words: Number(row.complimentary_words) || 0,
    hard_cap_words: row.hard_cap_words == null ? null : Number(row.hard_cap_words) }
}

function asStatus(raw: string | undefined): BillingStatus {
  const allowed: BillingStatus[] = [
    "none",
    "incomplete",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ]
  return allowed.includes(raw as BillingStatus) ? (raw as BillingStatus) : "none"
}

function unixToIso(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

/** Stripe 2025+ moved period timestamps onto the first subscription item. */
function periodUnix(obj: Record<string, unknown>, key: "current_period_start" | "current_period_end"): unknown {
  if (obj[key] != null) return obj[key]
  const items = obj.items as { data?: Array<Record<string, unknown>> } | undefined
  return items?.data?.[0]?.[key]
}

/** Receipt and effects commit together. A failed attempt leaves neither behind.
 * All effects must use tx; external Stripe reads belong before this transaction.
 * The organization lock also serializes distinct legacy add-on purchases when
 * org_billing does not exist yet. The unique event index deduplicates globally.
 */
export async function applyBillingEvent(
  db: AquillaDb,
  orgId: number,
  stripeEventId: string,
  kind: string,
  payload: unknown,
  apply: (tx: AquillaDb) => Promise<void>,
): Promise<boolean> {
  if (!stripeEventId) throw new Error("Stripe event ID is required")
  if (!db.transaction) throw new Error("Billing requires Postgres transactions")
  return db.transaction(async (tx) => {
    const org = await tx.prepare(
      "SELECT id FROM organizations WHERE id = ? FOR UPDATE",
    ).bind(orgId).first()
    if (!org) throw new Error("Billing organization does not exist")
    const receipt = await tx.prepare(
      `INSERT INTO org_billing_events (org_id, stripe_event_id, kind, payload_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id`,
    ).bind(orgId, stripeEventId, kind, JSON.stringify(payload).slice(0, 8000))
      .first<{ id: number }>()
    if (!receipt) return false
    await apply(tx)
    return true
  })
}

export async function upsertOrgBilling(
  db: AquillaDb,
  patch: {
    orgId: number
    stripeCustomerId?: string | null
    stripeSubscriptionId?: string | null
    plan?: BillingPlan
    status?: BillingStatus
    periodStart?: string | null
    periodEnd?: string | null
    addonPacks?: number
    complimentaryWords?: number
    hardCapWords?: number | null
    resetAddons?: boolean
  },
): Promise<void> {
  const current = await readOrgBilling(db, patch.orgId)
  const next: OrgBillingRow = {
    ...current,
    stripe_customer_id: patch.stripeCustomerId ?? current.stripe_customer_id,
    stripe_subscription_id: patch.stripeSubscriptionId ?? current.stripe_subscription_id,
    plan: patch.plan ?? current.plan,
    status: patch.status ?? current.status,
    current_period_start: patch.periodStart ?? current.current_period_start,
    current_period_end: patch.periodEnd ?? current.current_period_end,
    addon_packs: patch.resetAddons ? 0 : (patch.addonPacks ?? current.addon_packs),
    complimentary_words: patch.complimentaryWords ?? current.complimentary_words,
    hard_cap_words: patch.hardCapWords === undefined ? current.hard_cap_words : patch.hardCapWords,
  }

  const periodRolled =
    current.current_period_start != null &&
    next.current_period_start != null &&
    current.current_period_start !== next.current_period_start
  if (periodRolled) {
    next.addon_packs = 0
    next.complimentary_words = 0
  }

  await db
    .prepare(
      `INSERT INTO org_billing (
         org_id, stripe_customer_id, stripe_subscription_id, plan, status,
         current_period_start, current_period_end, addon_packs, complimentary_words,
         hard_cap_words, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
       ON CONFLICT (org_id) DO UPDATE SET
         stripe_customer_id     = EXCLUDED.stripe_customer_id,
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         plan                   = EXCLUDED.plan,
         status                 = EXCLUDED.status,
         current_period_start   = EXCLUDED.current_period_start,
         current_period_end     = EXCLUDED.current_period_end,
         addon_packs            = EXCLUDED.addon_packs,
         complimentary_words    = EXCLUDED.complimentary_words,
         hard_cap_words         = EXCLUDED.hard_cap_words,
         updated_at             = now()`,
    )
    .bind(
      next.org_id,
      next.stripe_customer_id,
      next.stripe_subscription_id,
      next.plan,
      next.status,
      next.current_period_start,
      next.current_period_end,
      next.addon_packs,
      next.complimentary_words,
      next.hard_cap_words,
    )
    .run()
}

export async function applySubscriptionSnapshot(
  db: AquillaDb,
  orgId: number,
  sub: {
    id: string
    customer: string
    status: string
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
  },
): Promise<void> {
  const status = asStatus(sub.status)
  const plan: BillingPlan = status === "canceled" || status === "none" ? "none" : "field"
  await upsertOrgBilling(db, {
    orgId,
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: sub.id,
    plan,
    status,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
  })
}

export async function applyAddonPurchase(db: AquillaDb, orgId: number, packs: number): Promise<void> {
  const current = await readOrgBilling(db, orgId)
  await upsertOrgBilling(db, {
    orgId,
    addonPacks: current.addon_packs + Math.max(1, Math.floor(packs)),
  })
}

export async function applyComplimentaryWords(db: AquillaDb, orgId: number, words: number): Promise<void> {
  const current = await readOrgBilling(db, orgId)
  await upsertOrgBilling(db, {
    orgId,
    complimentaryWords: current.complimentary_words + Math.max(0, Math.floor(words)),
  })
}

export function subscriptionFromStripeObject(obj: Record<string, unknown>): {
  id: string
  customer: string
  status: string
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
} {
  return {
    id: String(obj.id ?? ""),
    customer: String(obj.customer ?? ""),
    status: String(obj.status ?? "none"),
    currentPeriodStart: unixToIso(periodUnix(obj, "current_period_start")),
    currentPeriodEnd: unixToIso(periodUnix(obj, "current_period_end")),
  }
}

export function orgIdFromMetadata(meta: unknown): number | null {
  if (!meta || typeof meta !== "object") return null
  const raw = (meta as Record<string, unknown>).orgId
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}
