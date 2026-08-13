// Project Stripe webhook / checkout events onto org_billing.
// Idempotent on stripe_event_id. Period rollover zeroes addon_packs.

import type { BillingPlan, BillingStatus } from "./plans"
import { emptyBillingRow, readOrgBilling, type OrgBillingRow } from "./words"

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("does not exist") || msg.includes("undefined_table")
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

export async function rememberBillingEvent(
  db: AquillaDb,
  orgId: number | null,
  stripeEventId: string | null,
  kind: string,
  payload: unknown,
): Promise<boolean> {
  if (!stripeEventId) return true
  try {
    const existing = await db
      .prepare(`SELECT id FROM org_billing_events WHERE stripe_event_id = ?`)
      .bind(stripeEventId)
      .first<{ id: number }>()
    if (existing) return false
    await db
      .prepare(
        `INSERT INTO org_billing_events (org_id, stripe_event_id, kind, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(orgId, stripeEventId, kind, JSON.stringify(payload).slice(0, 8000))
      .run()
    return true
  } catch (err) {
    if (isMissingTableError(err)) return true
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("duplicate") || msg.includes("unique")) return false
    console.error("[billing] rememberBillingEvent error:", err)
    return true
  }
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
    hard_cap_words: patch.hardCapWords === undefined ? current.hard_cap_words : patch.hardCapWords,
  }

  const periodRolled =
    current.current_period_start != null &&
    next.current_period_start != null &&
    current.current_period_start !== next.current_period_start
  if (periodRolled) next.addon_packs = 0

  try {
    await db
      .prepare(
        `INSERT INTO org_billing (
           org_id, stripe_customer_id, stripe_subscription_id, plan, status,
           current_period_start, current_period_end, addon_packs, hard_cap_words, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
         ON CONFLICT (org_id) DO UPDATE SET
           stripe_customer_id     = EXCLUDED.stripe_customer_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           plan                   = EXCLUDED.plan,
           status                 = EXCLUDED.status,
           current_period_start   = EXCLUDED.current_period_start,
           current_period_end     = EXCLUDED.current_period_end,
           addon_packs            = EXCLUDED.addon_packs,
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
        next.hard_cap_words,
      )
      .run()
  } catch (err) {
    if (isMissingTableError(err)) return
    throw err
  }
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

export { emptyBillingRow }
