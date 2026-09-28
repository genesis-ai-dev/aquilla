import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { applyAddonPurchase, applySubscriptionSnapshot } from "../lib/billing/apply"
import { recordWords, readWordSnapshot, wordGuard } from "../lib/billing/words"
import { verifyStripeSignature } from "../lib/billing/stripe"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

function request(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(path, init, env))
}

async function seedOrg() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
  ).run()
}

describe("GET /api/v2/orgs/:orgId/billing", () => {
  it("403s a contributor and 200s a maintainer with the unpaid snapshot", async () => {
    await seedOrg()
    const member = await request(
      "http://local/api/v2/orgs/1/billing",
      { headers: authHeader(await jwtFor("anna")) },
    )
    expect(member.status).toBe(403)

    const owner = await request(
      "http://local/api/v2/orgs/1/billing",
      { headers: authHeader(await jwtFor("wendi")) },
    )
    expect(owner.status).toBe(200)
    const body = (await owner.json()) as {
      plan: string
      wordsUsed: number
      creditsUsed: number
      allowanceCredits: number
      canSubscribe: boolean
      checkoutEnabled: boolean
    }
    expect(body.plan).toBe("explore")
    expect(body.wordsUsed).toBe(0)
    expect(body.creditsUsed).toBe(0)
    expect(body.allowanceCredits).toBe(100)
    expect(body.canSubscribe).toBe(false) // no STRIPE_SECRET_KEY in test env
    expect(body.checkoutEnabled).toBe(false)
  })
})

describe("POST /api/v2/orgs/:orgId/billing/checkout", () => {
  it("keeps checkout unavailable before launch", async () => {
    await seedOrg()
    const res = await request("http://local/api/v2/orgs/1/billing/checkout", {
      method: "POST",
      headers: { ...authHeader(await jwtFor("wendi")), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "field" }),
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe("checkout_disabled")
  })
})

describe("pre-launch purchase gate", () => {
  it("stays closed with Stripe configured and ignores client-side launch flags", async () => {
    await seedOrg()
    const configured = { ...env, STRIPE_SECRET_KEY: "sk_test_not_a_real_key", BILLING_CHECKOUT_ENABLED: "false" }
    const headers = { ...authHeader(await jwtFor("wendi")), "Content-Type": "application/json" }
    const snapshot = await app.request("http://local/api/v2/orgs/1/billing", { headers }, configured)
    const body = await snapshot.json() as { checkoutEnabled: boolean; canSubscribe: boolean; canBuyAddon: boolean }
    expect(body).toMatchObject({ checkoutEnabled: false, canSubscribe: false, canBuyAddon: false })
    for (const kind of ["field", "addon"]) {
      const response = await app.request("http://local/api/v2/orgs/1/billing/checkout", {
        method: "POST", headers,
        body: JSON.stringify({ kind, billingInterval: "annual", checkoutEnabled: true }),
      }, configured)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: "checkout_disabled" })
    }
  })
})

describe("word ledger + guard", () => {
  it("records words and shows Explore's 100-credit allowance without blocking", async () => {
    await seedOrg()
    await recordWords(env.AQUILLA_PG, 1, 1, "llm", 50_000)
    const snap = await readWordSnapshot(env.AQUILLA_PG, 1)
    expect(snap.wordsUsed).toBe(50_000)
    expect(snap.creditsUsed).toBe(500)
    expect(snap.allowanceCredits).toBe(100)
    expect((await wordGuard(env.AQUILLA_PG, 1)).ok).toBe(true)
  })

  it("raises a Field org's allowance after an add-on pack, still without enforcing", async () => {
    await seedOrg()
    await applySubscriptionSnapshot(env.AQUILLA_PG, 1, {
      id: "sub_test",
      customer: "cus_test",
      status: "active",
      currentPeriodStart: new Date(Date.now() - 86400000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 27 * 86400000).toISOString(),
    })
    await recordWords(env.AQUILLA_PG, 1, 1, "agent", 100_000)
    expect((await wordGuard(env.AQUILLA_PG, 1)).ok).toBe(true)

    await applyAddonPurchase(env.AQUILLA_PG, 1, 1)
    const snap = await readWordSnapshot(env.AQUILLA_PG, 1)
    expect(snap.allowanceWords).toBe(200_000)
    expect(snap.allowanceCredits).toBe(2_000)
    expect(snap.addonPacks).toBe(1)
    expect((await wordGuard(env.AQUILLA_PG, 1)).ok).toBe(true)
  })

  it("records Enterprise hard-cap usage without blocking while enforcement is off", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_billing (org_id, plan, status, hard_cap_words, addon_packs)
       VALUES (1, 'enterprise', 'active', 5000, 0)`,
    ).run()
    await recordWords(env.AQUILLA_PG, 1, 1, "llm", 5000)
    const snap = await readWordSnapshot(env.AQUILLA_PG, 1)
    expect(snap.allowanceWords).toBe(5000)
    expect((await wordGuard(env.AQUILLA_PG, 1)).ok).toBe(true)
  })
})

describe("POST /api/v2/billing/webhook", () => {
  it("activates Field Plan from checkout.session.completed", async () => {
    await seedOrg()
    env.WRANGLER_LOCAL = "1"
    const payload = JSON.stringify({
      id: "evt_test_1",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_1",
          subscription: "sub_1",
          metadata: { orgId: "1", kind: "field" },
        },
      },
    })
    const res = await request("http://local/api/v2/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
    expect(res.status).toBe(200)
    const snap = await readWordSnapshot(env.AQUILLA_PG, 1)
    expect(snap.plan).toBe("field")
    expect(snap.status).toBe("active")
    env.WRANGLER_LOCAL = undefined
  })

  it("increments add-on packs from a one-time checkout", async () => {
    await seedOrg()
    await applySubscriptionSnapshot(env.AQUILLA_PG, 1, {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 28 * 86400000).toISOString(),
    })
    env.WRANGLER_LOCAL = "1"
    const payload = JSON.stringify({
      id: "evt_addon_1",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { orgId: "1", kind: "addon", packs: "2" },
        },
      },
    })
    const res = await request("http://local/api/v2/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
    expect(res.status).toBe(200)
    expect((await readWordSnapshot(env.AQUILLA_PG, 1)).addonPacks).toBe(2)
    env.WRANGLER_LOCAL = undefined
  })

  it("cancels Field Plan on customer.subscription.deleted", async () => {
    await seedOrg()
    await applySubscriptionSnapshot(env.AQUILLA_PG, 1, {
      id: "sub_cancel",
      customer: "cus_1",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 28 * 86400000).toISOString(),
    })
    env.WRANGLER_LOCAL = "1"
    const payload = JSON.stringify({
      id: "evt_cancel_1",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_cancel",
          customer: "cus_1",
          status: "canceled",
          metadata: { orgId: "1" },
        },
      },
    })
    const res = await request("http://local/api/v2/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
    expect(res.status).toBe(200)
    const snap = await readWordSnapshot(env.AQUILLA_PG, 1)
    expect(snap.plan).toBe("none")
    expect(snap.status).toBe("canceled")
    env.WRANGLER_LOCAL = undefined
  })

  it("rejects a bad Stripe signature when a webhook secret is set", async () => {
    env.STRIPE_WEBHOOK_SECRET = "whsec_test"
    const res = await request("http://local/api/v2/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=nope" },
      body: "{}",
    })
    expect(res.status).toBe(400)
    env.STRIPE_WEBHOOK_SECRET = undefined
  })
})

describe("verifyStripeSignature", () => {
  const secret = "whsec_test"
  const payload = "{\"ok\":true}"
  const sign = (t: number, key: string) =>
    bytesToHex(hmac(sha256, utf8ToBytes(key), utf8ToBytes(`${t}.${payload}`)))

  it("accepts a matching HMAC and rejects a stale timestamp", () => {
    const t = Math.floor(Date.now() / 1000)
    const v1 = sign(t, secret)
    expect(verifyStripeSignature({ payload, header: `t=${t},v1=${v1}`, secret })).toBe(true)
    expect(verifyStripeSignature({ payload, header: `t=${t - 400},v1=${v1}`, secret, nowSec: t })).toBe(false)
  })

  // OPS-12: Stripe signs with the old AND the new secret while a webhook
  // secret is rolled, so the header carries two v1 entries and only one of
  // them verifies under the secret this endpoint currently holds. Both
  // orderings must pass, or rotating the secret drops every event for the
  // length of the rollover.
  it("accepts either signature when a secret rollover puts two v1 entries in the header", () => {
    const t = Math.floor(Date.now() / 1000)
    const mine = sign(t, secret)
    const theirs = sign(t, "whsec_rotated")
    expect(verifyStripeSignature({ payload, header: `t=${t},v1=${mine},v1=${theirs}`, secret })).toBe(true)
    expect(verifyStripeSignature({ payload, header: `t=${t},v1=${theirs},v1=${mine}`, secret })).toBe(true)
  })

  it("still rejects when no candidate signature matches", () => {
    const t = Math.floor(Date.now() / 1000)
    const a = sign(t, "whsec_other_a")
    const b = sign(t, "whsec_other_b")
    expect(verifyStripeSignature({ payload, header: `t=${t},v1=${a},v1=${b}`, secret })).toBe(false)
    expect(verifyStripeSignature({ payload, header: `t=${t}`, secret })).toBe(false)
    expect(verifyStripeSignature({ payload, header: "", secret })).toBe(false)
  })

  it("does not accept a v0 signature in place of v1", () => {
    // v0 covers a different payload; treating the scheme as interchangeable
    // would accept a signature over content this endpoint never saw.
    const t = Math.floor(Date.now() / 1000)
    expect(verifyStripeSignature({ payload, header: `t=${t},v0=${sign(t, secret)}`, secret })).toBe(false)
  })
})


describe("GET /api/v2/orgs/:orgId/billing/offers", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("requires billing authority before fetching Stripe information", async () => {
    await seedOrg()
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const response = await request("http://local/api/v2/orgs/1/billing/offers", {
      headers: authHeader(await jwtFor("anna")),
    })
    expect(response.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })
  it("returns a safe unavailable catalog when configuration is missing", async () => {
    await seedOrg()
    const response = await request("http://local/api/v2/orgs/1/billing/offers", {
      headers: authHeader(await jwtFor("wendi")),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toMatchObject({ available: false, offers: [], checkoutEnabled: false })
  })
  it("passes real Stripe adapter output through the authenticated route", async () => {
    await seedOrg()
    const { default: manifest } = await import("../../../config/pricing/stripe-sandbox.json")
    const { stripeCatalogResponse } = await import("./helpers/stripe-catalog")
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(stripeCatalogResponse(new URL(url).pathname))))
    const response = await app.request("http://local/api/v2/orgs/1/billing/offers", {
      headers: authHeader(await jwtFor("wendi")),
    }, { ...env, STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_PRICE_CATALOG: JSON.stringify(manifest) })
    expect(response.status).toBe(200)
    const body = await response.json() as { available: boolean; offers: Array<{ offer: string; interval: string; totalAmount: number }> }
    expect(body.available).toBe(true)
    expect(body.offers.find(o => o.offer === "team_20x" && o.interval === "year")?.totalAmount).toBe(720000)
    expect(JSON.stringify(body)).not.toMatch(/credits|price_1|sk_test/i)
  })
})
