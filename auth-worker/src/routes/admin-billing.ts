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
import {
  createCatalogPrice,
  retrievePrice,
  stripeConfigured,
} from "../lib/billing/stripe"
import { readWordSnapshot, resetWordUsage, writeOrgBillingOverrides } from "../lib/billing/words"
import { grantCredits, resetCreditUsage } from "../lib/credits"
import { loadPlatformSettings, savePlatformSettings } from "../lib/platform-settings"

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

function publicPlan(plan: ReturnType<typeof resolveFieldPlan>) {
  return {
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
    plan: publicPlan(plan),
    version: rec.version,
    stripeConfigured: stripeConfigured(c.env),
    note: stripeConfigured(c.env)
      ? "Saving a new dollar amount creates a Stripe Price for future checkouts. Existing subscribers keep their current price."
      : "Stripe is not configured. Saving updates allowances and displayed amounts only. Checkout stays unconfigured until a secret + price ids exist.",
  })
})

const fieldPlanPatchSchema = z.object({
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
  return c.json({ plan: publicPlan(plan), version: saved.record.version, warnings })
})

adminBilling.get("/billing/orgs", async (c) => {
  const rec = await loadPlatformSettings(c.env)
  const catalog = resolveFieldPlan(rec.settings.fieldPlan, c.env)
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT id, name FROM organizations ORDER BY name ASC NULLS LAST, id ASC`,
  ).all<{ id: number; name: string | null }>()

  const orgs = []
  for (const org of results) {
    const snap = await readWordSnapshot(c.env.AQUILLA_PG, org.id, catalog)
    orgs.push({
      orgId: org.id,
      orgName: org.name,
      plan: snap.plan,
      status: snap.status,
      wordsUsed: snap.wordsUsed,
      allowanceWords: snap.allowanceWords,
      remainingWords: snap.remaining,
      addonPacks: snap.addonPacks,
      complimentaryWords: snap.complimentaryWords,
      hardCapWords: snap.hardCapWords,
      periodStart: snap.periodStart,
      periodEnd: snap.periodEnd,
      creditsUsed: snap.creditsUsed,
      allowanceCredits: snap.allowanceCredits,
      remainingCredits: snap.remainingCredits,
      complimentaryCredits: snap.complimentaryCredits,
      includedCredits: snap.includedCredits,
      languageCount: snap.languageCount,
      includedCreditsOverride: snap.includedCreditsOverride,
      billedLanguageCountOverride: snap.billedLanguageCountOverride,
      wordsPerCredit: snap.wordsPerCredit,
    })
  }
  return c.json({ orgs, plan: publicPlan(catalog) })
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

export default adminBilling
