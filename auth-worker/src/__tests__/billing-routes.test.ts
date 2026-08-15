import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { applyAddonPurchase, applySubscriptionSnapshot } from "../lib/billing/apply"
import { recordWords, readWordSnapshot, wordGuard } from "../lib/billing/words"
import { verifyStripeSignature } from "../lib/billing/stripe"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"

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
    const body = (await owner.json()) as { plan: string; wordsUsed: number; canSubscribe: boolean }
    expect(body.plan).toBe("none")
    expect(body.wordsUsed).toBe(0)
    expect(body.canSubscribe).toBe(false) // no STRIPE_SECRET_KEY in test env
  })
})

describe("POST /api/v2/orgs/:orgId/billing/checkout", () => {
  it("503s Field Plan checkout when Stripe is unconfigured", async () => {
    await seedOrg()
    const res = await request("http://local/api/v2/orgs/1/billing/checkout", {
      method: "POST",
      headers: { ...authHeader(await jwtFor("wendi")), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "field" }),
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe("stripe_unconfigured")
  })
})

describe("word ledger + guard", () => {
  it("records words and never blocks an unpaid org", async () => {
    await seedOrg()
    await recordWords(env.AQUILLA_PG, 1, 1, "llm", 50_000)
    const snap = await readWordSnapshot(env.AQUILLA_PG, 1)
    expect(snap.wordsUsed).toBe(50_000)
    expect(snap.allowanceWords).toBeNull()
    expect((await wordGuard(env.AQUILLA_PG, 1)).ok).toBe(true)
  })

  it("blocks a Field org at the included 100k, then allows after an add-on pack", async () => {
    await seedOrg()
    await applySubscriptionSnapshot(env.AQUILLA_PG, 1, {
      id: "sub_test",
      customer: "cus_test",
      status: "active",
      currentPeriodStart: new Date(Date.now() - 86400000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 27 * 86400000).toISOString(),
    })
    await recordWords(env.AQUILLA_PG, 1, 1, "agent", 100_000)
    const blocked = await wordGuard(env.AQUILLA_PG, 1)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe("allowance")

    await applyAddonPurchase(env.AQUILLA_PG, 1, 1)
    const allowed = await wordGuard(env.AQUILLA_PG, 1)
    expect(allowed.ok).toBe(true)
    const snap = await readWordSnapshot(env.AQUILLA_PG, 1)
    expect(snap.allowanceWords).toBe(200_000)
    expect(snap.addonPacks).toBe(1)
  })

  it("blocks Enterprise at the hard cap", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_billing (org_id, plan, status, hard_cap_words, addon_packs)
       VALUES (1, 'enterprise', 'active', 5000, 0)`,
    ).run()
    await recordWords(env.AQUILLA_PG, 1, 1, "llm", 5000)
    const blocked = await wordGuard(env.AQUILLA_PG, 1)
    expect(blocked).toMatchObject({ ok: false, reason: "hard_cap" })
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
  it("accepts a matching HMAC and rejects a stale timestamp", () => {
    const secret = "whsec_test"
    const payload = "{\"ok\":true}"
    const t = Math.floor(Date.now() / 1000)
    const v1 = bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`${t}.${payload}`)))
    expect(verifyStripeSignature({ payload, header: `t=${t},v1=${v1}`, secret })).toBe(true)
    expect(verifyStripeSignature({ payload, header: `t=${t - 400},v1=${v1}`, secret, nowSec: t })).toBe(false)
  })
})
