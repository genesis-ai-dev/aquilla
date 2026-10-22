// Platform-admin Field Plan catalog + per-org word/credit grants.
// Mounted on the admin router after elevation — same gate as credits PATCH.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { AuthHonoEnv } from "../middleware/auth"
import { applyComplimentaryWords, upsertOrgBilling } from "../lib/billing/apply"
import {
  type BillingPlan,
  type FieldPlanSettings,
  resolveFieldPlan,
} from "../lib/billing/plans"
import { rawUsdToAllowanceUnits, resolveAllowancePolicy, teamWeeklyRawUsd } from "../lib/billing/pricing-model"
import {
  createCatalogPrice,
  retrievePrice,
  stripeConfigured,
} from "../lib/billing/stripe"
import { readWordSnapshot, resetWordUsage, writeOrgBillingOverrides } from "../lib/billing/words"
import { grantCredits, resetCreditUsage } from "../lib/credits"
import { loadPlatformSettings, savePlatformSettings } from "../lib/platform-settings"
import { isMissingColumn, readWouldBlockReport, teamCostCheck } from "../lib/billing/admin-plan"
import { meterMode } from "../../../db/shared/ai-entitlement"
import { resolveOrgPlan } from "../../../db/shared/org-plan"
import { ADMIN_BILLING_PAGE_MAX, readAdminBillingOrgs } from "../lib/billing/admin-org-list"

const adminBilling = new Hono<AuthHonoEnv>()

async function audit(db: AquillaDb, userId: number, action: string, detail: unknown): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, ?, ?)`)
      .bind(userId, action, JSON.stringify(detail).slice(0, 4000))
      .run()
  } catch (err) {
    console.error("[admin-billing] audit log failed:", err)
  }
}

async function orgExists(db: AquillaDb, orgId: number): Promise<boolean> {
  const row = await db.prepare(`SELECT id FROM organizations WHERE id = ?`).bind(orgId).first<{ id: number }>()
  return row != null
}

function publicPlan(plan: ReturnType<typeof resolveFieldPlan>, stored: FieldPlanSettings | undefined) {
  const policy = resolveAllowancePolicy(stored)
  return {
    freeWeeklyAllowance: plan.freeWeeklyAllowance,
    freeWeeklyRawUsd: policy.freeWeeklyRawUsd,
    teamMultipleOfFree: policy.teamMultipleOfFree,
    teamWeeklyRawUsd: teamWeeklyRawUsd(policy),
    // AQU-2067: Team's worst-case raw cost against its revenue (spec Q7).
    teamCost: teamCostCheck(policy),
    unitsPerRawUsd: rawUsdToAllowanceUnits(1),
    // Internal display units for admin screens only; users see a percentage.
    freeWeeklyUnits: rawUsdToAllowanceUnits(policy.freeWeeklyRawUsd),
    teamWeeklyUnits: rawUsdToAllowanceUnits(teamWeeklyRawUsd(policy)),
    name: plan.name,
    intervalDays: plan.intervalDays,
    priceCents: plan.priceCents,
    includedWords: plan.includedWords,
    addonWords: plan.addonWords,
    addonPriceCents: plan.addonPriceCents,
    talkToUsWordsPerYear: plan.talkToUsWordsPerYear,
    stripePriceField: plan.stripePriceField,
    stripePriceAddon: plan.stripePriceAddon,
    wordsPerCredit: plan.wordsPerCredit,
    exploreCreditsPerCycle: plan.exploreCreditsPerCycle,
    fieldCreditsPerCycle: plan.fieldCreditsPerCycle,
    addonCredits: plan.addonCredits,
    enterpriseCreditsPerLanguagePerYear: plan.enterpriseCreditsPerLanguagePerYear,
  }
}

adminBilling.get("/billing/plans", async (c) => {
  const rec = await loadPlatformSettings(c.env)
  const plan = resolveFieldPlan(rec.settings.fieldPlan, c.env)
  return c.json({
    plan: publicPlan(plan, rec.settings.fieldPlan),
    version: rec.version,
    weeklyUsageEnforced: c.env.BILLING_WEEKLY_USAGE_ENFORCE === "true",
    meterMode: meterMode(c.env),
    stripeConfigured: stripeConfigured(c.env),
    note: stripeConfigured(c.env)
      ? "Saving a new dollar amount creates a Stripe Price for future checkouts. Existing subscribers keep their current price."
      : "Stripe is not configured. Saving updates allowances and displayed amounts only. Checkout stays unconfigured until a secret + price ids exist.",
  })
})

const fieldPlanPatchSchema = z.object({
  freeWeeklyAllowance: z.number().int().min(0).max(10_000_000).optional(),
  freeWeeklyRawUsd: z.number().min(0).max(10_000).optional(),
  teamMultipleOfFree: z.number().min(1).max(1_000).optional(),
  priceCents: z.number().int().min(100).max(10_000_000).optional(),
  addonPriceCents: z.number().int().min(100).max(10_000_000).optional(),
  includedWords: z.number().int().min(0).max(100_000_000).optional(),
  addonWords: z.number().int().min(1).max(100_000_000).optional(),
  talkToUsWordsPerYear: z.number().int().min(0).max(1_000_000_000).optional(),
  intervalDays: z.number().int().min(1).max(365).optional(),
  wordsPerCredit: z.number().int().min(1).max(10_000).optional(),
  exploreCreditsPerCycle: z.number().int().min(0).max(10_000_000).optional(),
  fieldCreditsPerCycle: z.number().int().min(0).max(10_000_000).optional(),
  addonCredits: z.number().int().min(1).max(10_000_000).optional(),
  enterpriseCreditsPerLanguagePerYear: z.number().int().min(0).max(10_000_000).optional(),
  ifMatchVersion: z.number().int().nonnegative(),
})

adminBilling.patch("/billing/plans", zValidator("json", fieldPlanPatchSchema), async (c) => {
  const user = c.get("user")
  const { ifMatchVersion, ...amounts } = c.req.valid("json")
  const rec = await loadPlatformSettings(c.env)
  const current = resolveFieldPlan(rec.settings.fieldPlan, c.env)
  const next: FieldPlanSettings = {
    ...rec.settings.fieldPlan,
    ...amounts,
    stripePriceField: rec.settings.fieldPlan?.stripePriceField ?? current.stripePriceField ?? undefined,
    stripePriceAddon: rec.settings.fieldPlan?.stripePriceAddon ?? current.stripePriceAddon ?? undefined,
  }

  const warnings: string[] = []
  if (stripeConfigured(c.env)) {
    try {
      if (amounts.priceCents != null && amounts.priceCents !== current.priceCents && current.stripePriceField) {
        const existing = await retrievePrice(c.env, current.stripePriceField)
        next.stripePriceField = await createCatalogPrice(c.env, {
          productId: existing.product,
          unitAmountCents: amounts.priceCents,
          recurring: true,
        })
      }
      if (
        amounts.addonPriceCents != null &&
        amounts.addonPriceCents !== current.addonPriceCents &&
        current.stripePriceAddon
      ) {
        const existing = await retrievePrice(c.env, current.stripePriceAddon)
        next.stripePriceAddon = await createCatalogPrice(c.env, {
          productId: existing.product,
          unitAmountCents: amounts.addonPriceCents,
          recurring: false,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stripe price create failed"
      warnings.push(message)
    }
  } else if (amounts.priceCents != null || amounts.addonPriceCents != null) {
    warnings.push("Stripe is not configured — dollar amounts are stored for display only.")
  }

  const saved = await savePlatformSettings(c.env, { fieldPlan: next }, ifMatchVersion, user.id)
  if (!saved.ok) return c.json({ error: "version_mismatch", current: saved.conflict }, 409)

  await audit(c.env.AQUILLA_PG, user.id, "billing.plans.update", { amounts, warnings })
  const plan = resolveFieldPlan(saved.record.settings.fieldPlan, c.env)
  return c.json({ plan: publicPlan(plan, saved.record.settings.fieldPlan), version: saved.record.version, warnings })
})

const orgListSchema = z.object({
  q: z.string().trim().max(200).optional(),
  tier: z.enum(["free", "team", "enterprise", "paid"]).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_BILLING_PAGE_MAX).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

/** One page of orgs with usage and plan. `total` counts every match, so the
 * console can page and search instead of loading the whole platform. */
adminBilling.get("/billing/orgs", zValidator("query", orgListSchema), async (c) => {
  const rec = await loadPlatformSettings(c.env)
  const catalog = resolveFieldPlan(rec.settings.fieldPlan, c.env)
  const query = c.req.valid("query")
  const { orgs, total } = await readAdminBillingOrgs(c.env.AQUILLA_PG, catalog, query)
  return c.json({ orgs, total, limit: query.limit, offset: query.offset, plan: publicPlan(catalog, rec.settings.fieldPlan) })
})

/** One org's row, in the list's shape — the console refreshes just that row
 * after a plan change or grant instead of reloading every page. */
adminBilling.get("/billing/orgs/:orgId", async (c) => {
  const raw = c.req.param("orgId") ?? ""
  const orgId = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(orgId) || orgId < 1) return c.json({ error: "invalid_org" }, 400)
  const rec = await loadPlatformSettings(c.env)
  const catalog = resolveFieldPlan(rec.settings.fieldPlan, c.env)
  const { orgs } = await readAdminBillingOrgs(c.env.AQUILLA_PG, catalog, { orgId, limit: 1, offset: 0 })
  if (orgs.length === 0) return c.json({ error: "not_found" }, 404)
  return c.json({ org: orgs[0] })
})

const orgPatchSchema = z.object({
  plan: z.enum(["none", "explore", "field", "enterprise"]).optional(),
  complimentaryWords: z.number().int().min(0).max(100_000_000).optional(),
  hardCapWords: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  addonPacks: z.number().int().min(0).max(500).optional(),
  includedCredits: z.number().int().min(0).max(10_000_000).nullable().optional(),
  billedLanguageCount: z.number().int().min(0).max(10_000).nullable().optional(),
})

adminBilling.patch("/billing/org/:orgId", zValidator("json", orgPatchSchema), async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await orgExists(c.env.AQUILLA_PG, orgId))) return c.json({ error: "not_found" }, 404)

  const patch = c.req.valid("json")
  const storedPlan = patch.plan === "explore" ? "none" : patch.plan
  const status =
    storedPlan === "none"
      ? "none"
      : storedPlan === "enterprise" || storedPlan === "field"
        ? "active"
        : undefined
  await upsertOrgBilling(c.env.AQUILLA_PG, {
    orgId,
    plan: storedPlan as BillingPlan | undefined,
    status,
    complimentaryWords: patch.complimentaryWords,
    hardCapWords: patch.hardCapWords,
    addonPacks: patch.addonPacks,
  })
  if (patch.includedCredits !== undefined || patch.billedLanguageCount !== undefined) {
    await writeOrgBillingOverrides(c.env.AQUILLA_PG, orgId, {
      includedCredits: patch.includedCredits,
      billedLanguageCount: patch.billedLanguageCount,
    })
  }
  await audit(c.env.AQUILLA_PG, c.get("user").id, "billing.org.update", { orgId, patch })
  const rec = await loadPlatformSettings(c.env)
  const snap = await readWordSnapshot(c.env.AQUILLA_PG, orgId, resolveFieldPlan(rec.settings.fieldPlan, c.env))
  return c.json({
    orgId,
    plan: snap.plan,
    complimentaryWords: snap.complimentaryWords,
    hardCapWords: snap.hardCapWords,
    addonPacks: snap.addonPacks,
    allowanceWords: snap.allowanceWords,
    wordsUsed: snap.wordsUsed,
    allowanceCredits: snap.allowanceCredits,
    creditsUsed: snap.creditsUsed,
    includedCreditsOverride: snap.includedCreditsOverride,
    billedLanguageCountOverride: snap.billedLanguageCountOverride,
  })
})

const orgPlanSchema = z.object({
  tier: z.enum(["free", "team", "enterprise"]),
  // Enterprise only. null = no end date; after it ends the org gets a 14-day
  // Team-sized grace, then Free (spec Q5).
  contractEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().trim().min(1).max(500),
}).strict()

/** AQU-2067: set an org's one plan (org_billing.tier, spec §4.2). The legacy
 * `plan` column is left alone for the Field code that still reads it (T18). */
adminBilling.patch("/billing/org/:orgId/plan", zValidator("json", orgPlanSchema), async (c) => {
  const raw = c.req.param("orgId") ?? ""
  const orgId = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(orgId) || orgId < 1) return c.json({ error: "invalid_org" }, 400)
  const { tier, contractEndsAt, reason } = c.req.valid("json")
  if (tier !== "enterprise" && contractEndsAt) return c.json({ error: "contract_end_requires_enterprise" }, 400)
  const db = c.env.AQUILLA_PG
  if (!db.transaction) return c.json({ error: "transactions_unavailable" }, 503)
  const endsAt = tier === "enterprise" ? (contractEndsAt ?? null) : null
  let result: "saved" | "not_found"
  try {
    result = await db.transaction(async tx => {
      const org = await tx.prepare("SELECT id FROM organizations WHERE id = ? FOR UPDATE").bind(orgId).first()
      if (!org) return "not_found" as const
      await tx.prepare(`INSERT INTO org_billing (org_id, tier, contract_ends_at) VALUES (?, ?, ?::timestamptz)
        ON CONFLICT (org_id) DO UPDATE SET tier = excluded.tier, contract_ends_at = excluded.contract_ends_at,
          updated_at = now()`)
        .bind(orgId, tier, endsAt).run()
      // Audit failure rolls back the plan change.
      await tx.prepare("INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, ?, ?)")
        .bind(c.get("user").id, "billing.org_plan.update", JSON.stringify({ orgId, tier, contractEndsAt: endsAt, reason })).run()
      return "saved" as const
    })
  } catch (err) {
    if (isMissingColumn(err)) return c.json({ error: "migration_0182_pending" }, 409)
    throw err
  }
  if (result === "not_found") return c.json({ error: "not_found" }, 404)
  const plan = await resolveOrgPlan(db, orgId)
  return c.json({
    orgId, tier, contractEndsAt: endsAt,
    resolvedTier: plan?.tier ?? tier, planSource: plan?.source ?? "stored",
    graceEndsAt: plan?.graceEndsAt ?? null, effectiveWeeklyAllowance: plan?.weeklyAllowanceUnits ?? null,
  })
})

/** AQU-2067: orgs and users the meter would have refused in each org's current
 * and previous weekly period (spec §5.4 shadow review). */
adminBilling.get("/billing/would-block", async (c) => {
  const orgs = await readWouldBlockReport(c.env.AQUILLA_PG)
  return c.json({ meterMode: meterMode(c.env), orgs })
})

const grantWordsSchema = z.object({
  words: z.number().int().min(1).max(10_000_000),
  reason: z.string().min(1).max(500),
})

adminBilling.post("/billing/org/:orgId/grant-words", zValidator("json", grantWordsSchema), async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await orgExists(c.env.AQUILLA_PG, orgId))) return c.json({ error: "not_found" }, 404)

  const body = c.req.valid("json")
  await applyComplimentaryWords(c.env.AQUILLA_PG, orgId, body.words)
  await audit(c.env.AQUILLA_PG, c.get("user").id, "billing.grant-words", { orgId, ...body })
  const rec = await loadPlatformSettings(c.env)
  const snap = await readWordSnapshot(c.env.AQUILLA_PG, orgId, resolveFieldPlan(rec.settings.fieldPlan, c.env))
  return c.json({ orgId, complimentaryWords: snap.complimentaryWords, allowanceWords: snap.allowanceWords })
})

const resetSchema = z.object({
  reason: z.string().min(1).max(500),
})

adminBilling.post("/billing/org/:orgId/reset-words", zValidator("json", resetSchema), async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await orgExists(c.env.AQUILLA_PG, orgId))) return c.json({ error: "not_found" }, 404)

  const deleted = await resetWordUsage(c.env.AQUILLA_PG, orgId)
  await audit(c.env.AQUILLA_PG, c.get("user").id, "billing.reset-words", { orgId, deleted, ...c.req.valid("json") })
  return c.json({ orgId, deleted })
})

const grantCreditsSchema = z.object({
  credits: z.number().int().min(1).max(1_000_000),
  reason: z.string().min(1).max(500),
})

adminBilling.post("/billing/org/:orgId/grant-credits", zValidator("json", grantCreditsSchema), async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await orgExists(c.env.AQUILLA_PG, orgId))) return c.json({ error: "not_found" }, 404)

  const body = c.req.valid("json")
  await grantCredits(c.env.AQUILLA_PG, c.env, orgId, body.credits)
  await audit(c.env.AQUILLA_PG, c.get("user").id, "billing.grant-credits", { orgId, ...body })
  return c.json({ orgId, granted: body.credits })
})

adminBilling.post("/billing/org/:orgId/reset-credits", zValidator("json", resetSchema), async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await orgExists(c.env.AQUILLA_PG, orgId))) return c.json({ error: "not_found" }, 404)

  const deleted = await resetCreditUsage(c.env.AQUILLA_PG, orgId)
  await audit(c.env.AQUILLA_PG, c.get("user").id, "billing.reset-credits", { orgId, deleted, ...c.req.valid("json") })
  return c.json({ orgId, deleted })
})

const weeklyGrantSchema = z.object({
  allowance: z.number().int().min(0).max(10_000_000).nullable().optional(),
  // AQU-2067: admins state allowances in raw provider dollars (spec §2.3).
  allowanceRawUsd: z.number().min(0).max(10_000).nullable().optional(),
  reason: z.string().trim().min(1).max(500),
}).strict().refine(b => (b.allowance === undefined) !== (b.allowanceRawUsd === undefined), {
  message: "Send exactly one of allowance or allowanceRawUsd",
})
adminBilling.patch('/billing/org/:orgId/weekly-allowance', zValidator('json', weeklyGrantSchema), async c => {
  const raw = c.req.param('orgId') ?? ''
  const orgId = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(orgId) || orgId < 1) return c.json({ error: 'invalid_org' }, 400)
  const db = c.env.AQUILLA_PG
  if (!db.transaction) return c.json({ error: 'transactions_unavailable' }, 503)
  const body = c.req.valid('json')
  const reason = body.reason
  const allowance = body.allowanceRawUsd !== undefined
    ? (body.allowanceRawUsd === null ? null : rawUsdToAllowanceUnits(body.allowanceRawUsd))
    : body.allowance ?? null
  const result = await db.transaction(async tx => {
    const org = await tx.prepare('SELECT id FROM organizations WHERE id = ? FOR UPDATE').bind(orgId).first()
    if (!org) return 'not_found' as const
    const pending = await tx.prepare(`SELECT id FROM workspace_checkout_attempts a
      WHERE a.org_id = ? AND a.resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_plan_entitlements e WHERE e.org_id = a.org_id)`)
      .bind(orgId).first()
    if (pending) return 'checkout_pending' as const
    await tx.prepare(`INSERT INTO org_billing (org_id, weekly_allowance) VALUES (?, ?)
      ON CONFLICT (org_id) DO UPDATE SET weekly_allowance = excluded.weekly_allowance`)
      .bind(orgId, allowance).run()
    // Audit failure rolls back the grant. Never reset usage or rewrite a subscription.
    await tx.prepare('INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, ?, ?)')
      .bind(c.get('user').id, 'billing.weekly_allowance.update', JSON.stringify({ orgId, allowance, reason })).run()
    return 'saved' as const
  })
  if (result === 'checkout_pending') return c.json({ error: 'checkout_pending' }, 409)
  return result === 'saved' ? c.json({ orgId, weeklyAllowance: allowance }) : c.json({ error: 'not_found' }, 404)
})
export default adminBilling
