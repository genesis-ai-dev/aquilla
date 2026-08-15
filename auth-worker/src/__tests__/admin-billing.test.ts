import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { applySubscriptionSnapshot } from "../lib/billing/apply"
import { recordWords, readWordSnapshot, wordGuard } from "../lib/billing/words"
import { recordCredit, resolveCreditConfig, readSpend } from "../lib/credits"

function request(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(path, init, env))
}

async function seedAdminOrg() {
  await seedUser(7, "root")
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
}

describe("admin billing catalog", () => {
  it("returns the default Field Plan and lets an admin change included words", async () => {
    await seedAdminOrg()
    const jwt = await jwtFor("root")
    const get = await request("/api/v2/admin/billing/plans", { headers: authHeader(jwt) })
    expect(get.status).toBe(200)
    const before = (await get.json()) as { plan: { includedWords: number; priceCents: number }; version: number }
    expect(before.plan.includedWords).toBe(100_000)
    expect(before.plan.priceCents).toBe(50_000)

    const patch = await request("/api/v2/admin/billing/plans", {
      method: "PATCH",
      headers: authHeader(jwt),
      body: JSON.stringify({ includedWords: 150_000, ifMatchVersion: before.version }),
    })
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as { plan: { includedWords: number } }).plan.includedWords).toBe(150_000)
  })

  it("403s a non-admin", async () => {
    await seedAdminOrg()
    const res = await request("/api/v2/admin/billing/plans", { headers: authHeader(await jwtFor("wendi")) })
    expect(res.status).toBe(403)
  })
})

describe("admin org word grants and resets", () => {
  it("grants complimentary words that lift a Field org off the cap", async () => {
    await seedAdminOrg()
    await applySubscriptionSnapshot(env.AQUILLA_PG, 1, {
      id: "sub_admin",
      customer: "cus_admin",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 28 * 86400000).toISOString(),
    })
    await recordWords(env.AQUILLA_PG, 1, 1, "llm", 100_000)
    expect((await wordGuard(env.AQUILLA_PG, 1)).ok).toBe(false)

    const res = await request("/api/v2/admin/billing/org/1/grant-words", {
      method: "POST",
      headers: authHeader(await jwtFor("root")),
      body: JSON.stringify({ words: 50_000, reason: "outage makeup" }),
    })
    expect(res.status).toBe(200)
    expect((await wordGuard(env.AQUILLA_PG, 1)).ok).toBe(true)
    expect((await readWordSnapshot(env.AQUILLA_PG, 1)).complimentaryWords).toBe(50_000)
  })

  it("resets word usage for an org", async () => {
    await seedAdminOrg()
    await applySubscriptionSnapshot(env.AQUILLA_PG, 1, {
      id: "sub_admin",
      customer: "cus_admin",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 28 * 86400000).toISOString(),
    })
    await recordWords(env.AQUILLA_PG, 1, 1, "agent", 80_000)
    const reset = await request("/api/v2/admin/billing/org/1/reset-words", {
      method: "POST",
      headers: authHeader(await jwtFor("root")),
      body: JSON.stringify({ reason: "test reset" }),
    })
    expect(reset.status).toBe(200)
    expect((await readWordSnapshot(env.AQUILLA_PG, 1)).wordsUsed).toBe(0)
  })

  it("assigns Enterprise and a hard cap from the admin panel", async () => {
    await seedAdminOrg()
    const res = await request("/api/v2/admin/billing/org/1", {
      method: "PATCH",
      headers: authHeader(await jwtFor("root")),
      body: JSON.stringify({ plan: "enterprise", hardCapWords: 2500 }),
    })
    expect(res.status).toBe(200)
    await recordWords(env.AQUILLA_PG, 1, 1, "llm", 2500)
    expect((await wordGuard(env.AQUILLA_PG, 1)).reason).toBe("hard_cap")
  })
})

describe("admin credit grants and resets", () => {
  it("grants credits that reduce reported spend, then reset zeros the ledger", async () => {
    await seedAdminOrg()
    await recordCredit(env.AQUILLA_PG, 1, 1, "llm", 100, 1)
    const cfg = await resolveCreditConfig(env, env.AQUILLA_PG, 1)
    const before = await readSpend(env.AQUILLA_PG, 1, cfg)
    expect(before.dayCredits).toBeGreaterThan(0)

    const grant = await request("/api/v2/admin/billing/org/1/grant-credits", {
      method: "POST",
      headers: authHeader(await jwtFor("root")),
      body: JSON.stringify({ credits: before.dayCredits, reason: "courtesy" }),
    })
    expect(grant.status).toBe(200)
    const afterGrant = await readSpend(env.AQUILLA_PG, 1, cfg)
    expect(afterGrant.dayCredits).toBe(0)

    await recordCredit(env.AQUILLA_PG, 1, 1, "llm", 50, 1)
    const reset = await request("/api/v2/admin/billing/org/1/reset-credits", {
      method: "POST",
      headers: authHeader(await jwtFor("root")),
      body: JSON.stringify({ reason: "wipe" }),
    })
    expect(reset.status).toBe(200)
    expect((await readSpend(env.AQUILLA_PG, 1, cfg)).dayCredits).toBe(0)
  })
})
