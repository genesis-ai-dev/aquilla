// Org billing — Field Plan checkout, word add-ons, customer portal, Stripe webhook.
//
// Authenticated org routes require maintainer+ (600). The webhook is public
// and verified with Stripe-Signature.

import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { ROLE } from "../types"
import {
  applyAddonPurchase,
  applySubscriptionSnapshot,
  orgIdFromMetadata,
  rememberBillingEvent,
  subscriptionFromStripeObject,
} from "../lib/billing/apply"
import { FIELD_PLAN } from "../lib/billing/plans"
import {
  addonPriceId,
  createCheckoutSession,
  createPortalSession,
  fieldPriceId,
  retrieveSubscription,
  stripeConfigured,
  StripeConfigError,
  verifyStripeSignature,
} from "../lib/billing/stripe"
import { readOrgBilling, readWordSnapshot } from "../lib/billing/words"

const billing = new Hono<AuthHonoEnv>()

function spaOrigin(env: { BASE_URL?: string }): string {
  return (env.BASE_URL ?? "https://aquilla.app").replace(/\/+$/, "")
}

function billingReturnUrl(env: { BASE_URL?: string }, orgId: number, query = ""): string {
  return `${spaOrigin(env)}/orgs/${orgId}/settings/billing${query}`
}

async function requireMaintainer(c: Context<AuthHonoEnv>, orgId: number) {
  const role = await getEffectiveOrgRole(c.env, orgId, c.get("user"))
  if (role == null || role < ROLE.MAINTAINER) return false
  return true
}

billing.get("/orgs/:orgId/billing", authMiddleware, async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await requireMaintainer(c, orgId))) return c.json({ error: "forbidden" }, 403)

  const snapshot = await readWordSnapshot(c.env.AQUILLA_PG, orgId)
  return c.json({
    plan: snapshot.plan,
    status: snapshot.status,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    wordsUsed: snapshot.wordsUsed,
    trailingYearWords: snapshot.trailingYearWords,
    addonPacks: snapshot.addonPacks,
    includedWords: snapshot.includedWords,
    allowanceWords: snapshot.allowanceWords,
    remainingWords: snapshot.remaining,
    hardCapWords: snapshot.hardCapWords,
    talkToUs: snapshot.talkToUs,
    canSubscribe: snapshot.plan === "none" && stripeConfigured(c.env),
    canBuyAddon: snapshot.plan === "field" && !snapshot.talkToUs && stripeConfigured(c.env),
    canManage: Boolean(snapshot.stripeCustomerId) && stripeConfigured(c.env),
    stripeConfigured: stripeConfigured(c.env),
    fieldPlan: {
      name: FIELD_PLAN.name,
      intervalDays: FIELD_PLAN.intervalDays,
      priceCents: FIELD_PLAN.priceCents,
      includedWords: FIELD_PLAN.includedWords,
      addonWords: FIELD_PLAN.addonWords,
      addonPriceCents: FIELD_PLAN.addonPriceCents,
      talkToUsWordsPerYear: FIELD_PLAN.talkToUsWordsPerYear,
    },
  })
})

const checkoutSchema = z.object({
  kind: z.enum(["field", "addon"]),
  packs: z.number().int().min(1).max(20).optional(),
})

billing.post("/orgs/:orgId/billing/checkout", authMiddleware, async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await requireMaintainer(c, orgId))) return c.json({ error: "forbidden" }, 403)

  let body: z.infer<typeof checkoutSchema>
  try {
    body = checkoutSchema.parse(await c.req.json())
  } catch {
    return c.json({ error: "invalid body" }, 400)
  }

  const snapshot = await readWordSnapshot(c.env.AQUILLA_PG, orgId)
  if (snapshot.plan === "enterprise") {
    return c.json({ error: "enterprise_org", message: "Enterprise orgs are billed offline. Talk to us to change the cap." }, 409)
  }
  if (body.kind === "field" && snapshot.plan === "field") {
    return c.json({ error: "already_subscribed", message: "This organization is already on the Field Plan." }, 409)
  }
  if (body.kind === "addon" && snapshot.plan !== "field") {
    return c.json({ error: "not_subscribed", message: "Buy the Field Plan before adding word packs." }, 409)
  }
  if (body.kind === "addon" && snapshot.talkToUs) {
    return c.json({ error: "talk_to_us", message: "This volume needs an Enterprise conversation." }, 409)
  }

  const user = c.get("user")
  try {
    const session = await createCheckoutSession(c.env, {
      customerId: snapshot.stripeCustomerId ?? undefined,
      customerEmail: snapshot.stripeCustomerId ? undefined : user.email,
      priceId: body.kind === "field" ? fieldPriceId(c.env) : addonPriceId(c.env),
      mode: body.kind === "field" ? "subscription" : "payment",
      quantity: body.kind === "addon" ? (body.packs ?? 1) : 1,
      successUrl: billingReturnUrl(c.env, orgId, "?checkout=success"),
      cancelUrl: billingReturnUrl(c.env, orgId, "?checkout=cancel"),
      metadata: {
        orgId: String(orgId),
        kind: body.kind,
        packs: String(body.kind === "addon" ? (body.packs ?? 1) : 0),
      },
    })
    if (!session.url) return c.json({ error: "stripe_error", message: "Checkout session missing URL" }, 502)
    return c.json({ url: session.url })
  } catch (err) {
    if (err instanceof StripeConfigError) {
      return c.json({ error: "stripe_unconfigured", message: err.message }, 503)
    }
    const message = err instanceof Error ? err.message : "Checkout failed"
    return c.json({ error: "stripe_error", message }, 502)
  }
})

billing.post("/orgs/:orgId/billing/portal", authMiddleware, async (c) => {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  if (!(await requireMaintainer(c, orgId))) return c.json({ error: "forbidden" }, 403)

  const billingRow = await readOrgBilling(c.env.AQUILLA_PG, orgId)
  if (!billingRow.stripe_customer_id) {
    return c.json({ error: "no_customer", message: "This organization has no Stripe customer yet." }, 409)
  }
  try {
    const session = await createPortalSession(
      c.env,
      billingRow.stripe_customer_id,
      billingReturnUrl(c.env, orgId),
    )
    return c.json({ url: session.url })
  } catch (err) {
    if (err instanceof StripeConfigError) {
      return c.json({ error: "stripe_unconfigured", message: err.message }, 503)
    }
    const message = err instanceof Error ? err.message : "Portal failed"
    return c.json({ error: "stripe_error", message }, 502)
  }
})

billing.post("/billing/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET?.trim()
  const payload = await c.req.text()
  if (secret) {
    const header = c.req.header("stripe-signature") ?? ""
    if (!verifyStripeSignature({ payload, header, secret })) {
      return c.json({ error: "invalid_signature" }, 400)
    }
  } else if (c.env.WRANGLER_LOCAL !== "1") {
    return c.json({ error: "webhook_unconfigured" }, 503)
  }

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(payload) as typeof event
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }

  const obj = event.data?.object ?? {}
  const type = event.type ?? ""
  const eventId = typeof event.id === "string" ? event.id : null

  try {
    if (type === "checkout.session.completed") {
      const orgId = orgIdFromMetadata(obj.metadata)
      if (orgId == null) return c.json({ ok: true, ignored: "no_org" })
      if (!(await rememberBillingEvent(c.env.AQUILLA_PG, orgId, eventId, type, obj))) {
        return c.json({ ok: true, duplicate: true })
      }
      const kind = String((obj.metadata as Record<string, string> | undefined)?.kind ?? "")
      const customer = typeof obj.customer === "string" ? obj.customer : null
      const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null
      if (kind === "addon") {
        const packs = Number((obj.metadata as Record<string, string> | undefined)?.packs ?? 1)
        await applyAddonPurchase(c.env.AQUILLA_PG, orgId, packs)
      } else if (subscriptionId && stripeConfigured(c.env)) {
        const sub = await retrieveSubscription(c.env, subscriptionId)
        await applySubscriptionSnapshot(c.env.AQUILLA_PG, orgId, sub)
      } else if (subscriptionId) {
        await applySubscriptionSnapshot(c.env.AQUILLA_PG, orgId, {
          id: subscriptionId,
          customer: customer ?? "",
          status: "active",
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + FIELD_PLAN.intervalDays * 86_400_000).toISOString(),
        })
      }
    } else if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      const sub = subscriptionFromStripeObject(obj)
      const orgId =
        orgIdFromMetadata(obj.metadata) ??
        (await lookupOrgIdBySubscription(c.env.AQUILLA_PG, sub.id))
      if (orgId == null) return c.json({ ok: true, ignored: "no_org" })
      if (!(await rememberBillingEvent(c.env.AQUILLA_PG, orgId, eventId, type, obj))) {
        return c.json({ ok: true, duplicate: true })
      }
      if (type === "customer.subscription.deleted") {
        await applySubscriptionSnapshot(c.env.AQUILLA_PG, orgId, { ...sub, status: "canceled" })
      } else {
        await applySubscriptionSnapshot(c.env.AQUILLA_PG, orgId, sub)
      }
    } else if (type === "invoice.paid") {
      const subscriptionId =
        typeof obj.subscription === "string"
          ? obj.subscription
          : typeof (obj.parent as { subscription_details?: { subscription?: string } } | undefined)
                ?.subscription_details?.subscription === "string"
            ? (obj.parent as { subscription_details: { subscription: string } }).subscription_details.subscription
            : null
      if (!subscriptionId) return c.json({ ok: true, ignored: "no_subscription" })
      const orgId = await lookupOrgIdBySubscription(c.env.AQUILLA_PG, subscriptionId)
      if (orgId == null) return c.json({ ok: true, ignored: "no_org" })
      if (!(await rememberBillingEvent(c.env.AQUILLA_PG, orgId, eventId, type, obj))) {
        return c.json({ ok: true, duplicate: true })
      }
      if (stripeConfigured(c.env)) {
        const sub = await retrieveSubscription(c.env, subscriptionId)
        await applySubscriptionSnapshot(c.env.AQUILLA_PG, orgId, sub)
      }
    }
  } catch (err) {
    console.error("[billing] webhook handler error:", err)
    return c.json({ error: "handler_failed" }, 500)
  }

  return c.json({ ok: true })
})

async function lookupOrgIdBySubscription(db: AquillaDb, subscriptionId: string): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT org_id FROM org_billing WHERE stripe_subscription_id = ?`)
      .bind(subscriptionId)
      .first<{ org_id: number }>()
    return row?.org_id ?? null
  } catch {
    return null
  }
}

export default billing
