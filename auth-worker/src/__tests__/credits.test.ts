// Contract tests for the credit accounting system (WS-AUTH-CREDITS).
//
// Spec: docs/superpowers/specs/2026-06-13-org-credits-cost-model.md.
//
// Intent: each test encodes WHY the behavior matters, not just WHAT it does.
//
//   Section A — Pure formula functions (no DB):
//     creditsFor: markup incl. agent 5×; base 4×; zero cost stays zero.
//     checkCredits: correct reason for each of the four caps; enforce-off never
//       blocks; agent sub-caps apply only to the agent rail.
//
//   Section B — DB-backed functions:
//     recordCredit: upsert works; degrade-to-silent on missing table.
//     readSpend: day/week window; agent sub-total; rolling-7d excludes day-8;
//       missing table → zeros.
//
//   Section C — creditGuard:
//     log-only (enforce=false): over-cap still returns ok=true.
//     enforce=true: blocks with correct reason + status 429.
//
//   Section D — HTTP endpoints:
//     GET /usage/org/:orgId/credits: 403 for non-maintainer; 403 for maintainer
//       when showToOrg=false; 200 + correct shape for maintainer+showToOrg;
//       200 for platform-admin regardless.
//     GET /admin/credits/orgs: lists all orgs with spend + caps.
//     PATCH /admin/credits/org/:orgId: writes org_settings.credits; partial merge.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeAll } from "vitest"
import {
  creditsFor,
  checkCredits,
  recordCredit,
  readSpend,
  creditGuard,
  resolveCreditConfig,
  type CreditConfig,
  type OrgSpend,
} from "../lib/credits"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { pg } from "./helpers/pg-test-env"

// ── Seed the org_credit_usage_daily table before all tests ───────────────────
// The migration (0042) may not be in the schema yet; CREATE TABLE IF NOT EXISTS
// is a no-op if it already exists.
beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS org_credit_usage_daily (
      org_id         INTEGER          NOT NULL,
      user_id        INTEGER          NOT NULL,
      date_utc       DATE             NOT NULL,
      rail           TEXT             NOT NULL,
      raw_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
      units          INTEGER          NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, user_id, date_utc, rail)
    )
  `)
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_credit_org_date
      ON org_credit_usage_daily (org_id, date_utc)
  `)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultCfg: CreditConfig = {
  markup: 4,
  agentMarkup: 5,
  dailyCap: 1000,
  weeklyCap: 5000,
  agentDailyCap: 600,
  agentWeeklyCap: 3000,
  enforce: false,
  showToOrg: false,
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function insertRawRow(
  orgId: number,
  userId: number,
  dateUtc: string,
  rail: string,
  rawCostCents: number,
  units = 1,
) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_credit_usage_daily
       (org_id, user_id, date_utc, rail, raw_cost_cents, units)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, user_id, date_utc, rail)
     DO UPDATE SET
       raw_cost_cents = org_credit_usage_daily.raw_cost_cents + EXCLUDED.raw_cost_cents,
       units          = org_credit_usage_daily.units          + EXCLUDED.units`,
  )
    .bind(orgId, userId, dateUtc, rail, rawCostCents, units)
    .run()
}

async function seedOrgAndAdmin() {
  await seedUser(7, "root")
  await seedUser(1, "wendi")   // org 1 maintainer (600)
  await seedUser(2, "anna")    // org 1 contributor (400)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 600, 1), (1, 2, 400, 1)",
  ).run()
}

// ── Section A: Pure formula tests (no DB) ────────────────────────────────────

describe("creditsFor", () => {
  it("applies base markup (4×) for llm rail — intent: 4× covers invisible platform costs", () => {
    // 10¢ raw × 4 = 40 credits; ceil(40) = 40.
    expect(creditsFor(10, "llm", defaultCfg)).toBe(40)
  })

  it("applies base markup (4×) for tts rail — intent: non-agent rails share the same base", () => {
    expect(creditsFor(10, "tts", defaultCfg)).toBe(40)
  })

  it("applies agent markup (5×) for agent rail — intent: agent burns fastest, needs stricter cap", () => {
    // 10¢ raw × 5 = 50 credits.
    expect(creditsFor(10, "agent", defaultCfg)).toBe(50)
  })

  it("ceils fractional credits — intent: provider costs often produce non-integer cents", () => {
    // 1¢ raw × 4 = 4 (exact); 0.3¢ × 4 = 1.2 → ceil → 2.
    expect(creditsFor(0.3, "llm", defaultCfg)).toBe(2)
  })

  it("zero raw cost → zero credits — intent: no-cost calls don't pollute the ledger", () => {
    expect(creditsFor(0, "agent", defaultCfg)).toBe(0)
  })

  it("respects custom markup overrides — intent: per-org markup must override defaults", () => {
    const custom = { ...defaultCfg, markup: 3, agentMarkup: 7 }
    expect(creditsFor(10, "llm", custom)).toBe(30)
    expect(creditsFor(10, "agent", custom)).toBe(70)
  })
})

describe("checkCredits", () => {
  // Helper: build a spend object with controlled values.
  function makeSpend(overrides: Partial<OrgSpend> = {}): OrgSpend {
    return {
      dayCredits: 0,
      weekCredits: 0,
      agentDayCredits: 0,
      agentWeekCredits: 0,
      byRailDay: {},
      byRailWeek: {},
      ...overrides,
    }
  }

  it("blocks on daily cap — intent: daily cap prevents a single bad day from draining budget", () => {
    const spend = makeSpend({ dayCredits: 1000, weekCredits: 1000 })
    const result = checkCredits(spend, "llm", defaultCfg)
    expect(result).toEqual({ ok: false, reason: "daily" })
  })

  it("blocks on weekly cap when daily is under — intent: weekly catches sustained overuse across days", () => {
    const spend = makeSpend({ dayCredits: 999, weekCredits: 5000 })
    const result = checkCredits(spend, "llm", defaultCfg)
    expect(result).toEqual({ ok: false, reason: "weekly" })
  })

  it("blocks on agent_daily cap for agent rail — intent: agent sub-cap prevents runaway agent loops", () => {
    const spend = makeSpend({
      dayCredits: 500,
      weekCredits: 2000,
      agentDayCredits: 600,
    })
    const result = checkCredits(spend, "agent", defaultCfg)
    expect(result).toEqual({ ok: false, reason: "agent_daily" })
  })

  it("blocks on agent_weekly cap for agent rail — intent: weekly agent sub-cap bounds the whole week", () => {
    const spend = makeSpend({
      dayCredits: 500,
      weekCredits: 2000,
      agentDayCredits: 599,
      agentWeekCredits: 3000,
    })
    const result = checkCredits(spend, "agent", defaultCfg)
    expect(result).toEqual({ ok: false, reason: "agent_weekly" })
  })

  it("agent sub-caps do NOT apply to non-agent rails — intent: llm/tts use only the global caps", () => {
    // Even if agentDayCredits is over, llm rail is unaffected.
    const spend = makeSpend({
      dayCredits: 0,
      weekCredits: 0,
      agentDayCredits: 9999,
      agentWeekCredits: 9999,
    })
    const result = checkCredits(spend, "llm", defaultCfg)
    expect(result).toEqual({ ok: true })
  })

  it("all under cap → ok — intent: green path passes through", () => {
    const spend = makeSpend({ dayCredits: 999, weekCredits: 4999, agentDayCredits: 599, agentWeekCredits: 2999 })
    expect(checkCredits(spend, "agent", defaultCfg)).toEqual({ ok: true })
  })

  it("precedence: daily blocks before weekly — intent: daily cap produces the right user-facing reason", () => {
    const spend = makeSpend({ dayCredits: 1000, weekCredits: 5000 })
    expect(checkCredits(spend, "llm", defaultCfg).reason).toBe("daily")
  })
})

// ── Section B: DB-backed functions ───────────────────────────────────────────

describe("recordCredit", () => {
  it("inserts a new row then accumulates on conflict — intent: upsert must aggregate not overwrite", async () => {
    await recordCredit(env.AQUILLA_PG, 1, 1, "llm", 10, 1)
    await recordCredit(env.AQUILLA_PG, 1, 1, "llm", 15, 2) // same PK → sum

    const row = await env.AQUILLA_PG
      .prepare("SELECT raw_cost_cents, units FROM org_credit_usage_daily WHERE org_id=1 AND user_id=1 AND rail='llm' AND date_utc=?")
      .bind(today())
      .first<{ raw_cost_cents: number; units: number }>()

    expect(row?.raw_cost_cents).toBe(25)
    expect(row?.units).toBe(3)
  })

  it("degrades silently when the table is missing — intent: migration-not-yet-applied must never crash a route", async () => {
    await pg.exec("DROP TABLE IF EXISTS org_credit_usage_daily")
    // Should not throw.
    await expect(recordCredit(env.AQUILLA_PG, 1, 1, "agent", 5, 1)).resolves.toBeUndefined()
    // Recreate for subsequent tests.
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS org_credit_usage_daily (
        org_id         INTEGER          NOT NULL,
        user_id        INTEGER          NOT NULL,
        date_utc       DATE             NOT NULL,
        rail           TEXT             NOT NULL,
        raw_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
        units          INTEGER          NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, user_id, date_utc, rail)
      )
    `)
  })
})

describe("readSpend", () => {
  it("returns zeros for an org with no rows — intent: fresh org is never over cap", async () => {
    const spend = await readSpend(env.AQUILLA_PG, 99, defaultCfg)
    expect(spend.dayCredits).toBe(0)
    expect(spend.weekCredits).toBe(0)
    expect(spend.agentDayCredits).toBe(0)
  })

  it("converts raw cents to credits using markup — intent: markup applied at read, not write", async () => {
    // 10 raw × 4 markup = 40 credits.
    await insertRawRow(1, 1, today(), "llm", 10)
    const spend = await readSpend(env.AQUILLA_PG, 1, defaultCfg)
    expect(spend.dayCredits).toBe(40)
    expect(spend.weekCredits).toBe(40)
    expect(spend.byRailDay["llm"]).toBe(40)
  })

  it("agent rail uses agentMarkup (5×), not base markup — intent: agent markup drives agent sub-cap correctly", async () => {
    await insertRawRow(1, 1, today(), "agent", 10)
    const spend = await readSpend(env.AQUILLA_PG, 1, defaultCfg)
    // 10 raw × 5 agentMarkup = 50; agent is also included in total.
    expect(spend.agentDayCredits).toBe(50)
    expect(spend.dayCredits).toBe(50)
  })

  it("rolling 7-day window: day-7 is included, day-8 is excluded — intent: rolling window is inclusive on both ends", async () => {
    // day-7 = 6 days ago (today - 6), day-8 = 7 days ago.
    const day7 = daysAgo(6)  // oldest day in the 7-day window
    const day8 = daysAgo(7)  // one day outside the window

    await insertRawRow(1, 1, day7, "llm", 5)  // should appear in week total
    await insertRawRow(1, 1, day8, "llm", 5)  // must NOT appear

    const spend = await readSpend(env.AQUILLA_PG, 1, defaultCfg)
    // 5 raw × 4 markup = 20 credits from day7 only.
    expect(spend.weekCredits).toBe(20)
    // day-8 row must not bleed into week total.
    const row = await env.AQUILLA_PG
      .prepare("SELECT raw_cost_cents FROM org_credit_usage_daily WHERE date_utc=?")
      .bind(day8)
      .first<{ raw_cost_cents: number }>()
    expect(row?.raw_cost_cents).toBe(5) // it's stored but not included in spend
  })

  it("org isolation: org 2 rows don't appear in org 1 spend — intent: cross-org leakage must be impossible", async () => {
    await insertRawRow(1, 1, today(), "llm", 10)  // org 1
    await insertRawRow(2, 1, today(), "llm", 100) // org 2
    const spend = await readSpend(env.AQUILLA_PG, 1, defaultCfg)
    // Only org 1: 10 × 4 = 40.
    expect(spend.dayCredits).toBe(40)
  })

  it("degrades to zeros when table is missing — intent: migration-lag must not 500 the credits endpoint", async () => {
    await pg.exec("DROP TABLE IF EXISTS org_credit_usage_daily")
    const spend = await readSpend(env.AQUILLA_PG, 1, defaultCfg)
    expect(spend.dayCredits).toBe(0)
    expect(spend.weekCredits).toBe(0)
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS org_credit_usage_daily (
        org_id         INTEGER          NOT NULL,
        user_id        INTEGER          NOT NULL,
        date_utc       DATE             NOT NULL,
        rail           TEXT             NOT NULL,
        raw_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
        units          INTEGER          NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, user_id, date_utc, rail)
      )
    `)
  })
})

// ── Section C: creditGuard ────────────────────────────────────────────────────

describe("creditGuard", () => {
  it("log-only (enforce=false): over-daily-cap still returns ok=true — intent: default is observe, not block", async () => {
    // Seed 250 raw × 4 = 1000 credits = exactly at the daily cap.
    await insertRawRow(1, 1, today(), "llm", 250)

    // env has CREDIT_ENFORCE unset → enforce=false.
    const result = await creditGuard(env.AQUILLA_PG, env, 1, "llm")
    expect(result.ok).toBe(true)
  })

  it("enforce=true: over daily cap → 429 with reason=daily — intent: flip enforce to activate billing protection", async () => {
    // Set a tiny daily cap by using org_settings.credits.
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 1, 1)",
    ).bind(JSON.stringify({ credits: { dailyCap: 10, enforce: true } })).run()

    // Seed 3 raw × 4 = 12 credits — over the 10 cap.
    await insertRawRow(1, 1, today(), "llm", 3)

    const result = await creditGuard(env.AQUILLA_PG, env, 1, "llm")
    expect(result.ok).toBe(false)
    expect(result.status).toBe(429)
    expect(result.reason).toBe("daily")
  })

  it("enforce=true: agent over agent_daily cap → reason=agent_daily — intent: agent sub-cap has its own 429 reason", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
    ).run()
    // Set agentDailyCap = 10, enforce = true; dailyCap high so only agent sub-cap fires.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 1, 1)",
    ).bind(JSON.stringify({ credits: { dailyCap: 9999, weeklyCap: 99999, agentDailyCap: 10, enforce: true } })).run()

    // 3 raw × 5 agentMarkup = 15 credits — over the 10 agent daily cap.
    await insertRawRow(1, 1, today(), "agent", 3)

    const result = await creditGuard(env.AQUILLA_PG, env, 1, "agent")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("agent_daily")
  })

  it("under cap always returns ok=true — intent: green path must never block", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 1, 1)",
    ).bind(JSON.stringify({ credits: { enforce: true } })).run()

    // No rows → spend = 0 → under all caps.
    const result = await creditGuard(env.AQUILLA_PG, env, 1, "agent")
    expect(result.ok).toBe(true)
  })
})

// ── Section D: HTTP endpoints ─────────────────────────────────────────────────

describe("GET /api/v1/usage/org/:orgId/credits", () => {
  it("returns 401 without a token — intent: unauthenticated callers never see credit data", async () => {
    const res = await app.request("/api/v1/usage/org/1/credits", {}, env)
    expect(res.status).toBe(401)
  })

  it("returns 403 for a contributor (anna) — intent: only managers or admins can see credit data", async () => {
    await seedOrgAndAdmin()
    const res = await app.request(
      "/api/v1/usage/org/1/credits",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("returns 403 for an org-maintainer when showToOrg=false — intent: org-admin self-service requires explicit flag", async () => {
    await seedOrgAndAdmin()
    // No org_settings row → showToOrg defaults to false.
    const res = await app.request(
      "/api/v1/usage/org/1/credits",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("returns 200 for org-maintainer when showToOrg=true — intent: flag enables self-service visibility", async () => {
    await seedOrgAndAdmin()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 1, 1)",
    ).bind(JSON.stringify({ credits: { showToOrg: true } })).run()

    const res = await app.request(
      "/api/v1/usage/org/1/credits",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      config: { markup: number; agentMarkup: number; dailyCap: number; showToOrg: boolean }
      day: { totalCredits: number; agentCredits: number; byRail: Record<string, number> }
      week: { totalCredits: number }
      remaining: { daily: number; weekly: number; agentDaily: number; agentWeekly: number }
    }
    expect(body.config.markup).toBe(4)
    expect(body.config.agentMarkup).toBe(5)
    expect(body.config.showToOrg).toBe(true)
    expect(typeof body.day.totalCredits).toBe("number")
    expect(typeof body.remaining.daily).toBe("number")
  })

  it("returns 200 for platform-admin regardless of showToOrg — intent: platform-admin has unrestricted read access", async () => {
    await seedOrgAndAdmin()
    // showToOrg NOT set (defaults false) — admin should still get 200.
    const res = await app.request(
      "/api/v1/usage/org/1/credits",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: { dailyCap: number } }
    expect(body.config.dailyCap).toBe(1000) // env default
  })

  it("remaining decrements as spend increases — intent: remaining must reflect live spend", async () => {
    await seedOrgAndAdmin()
    // Enable showToOrg so wendi can read (or just use root).
    await insertRawRow(1, 1, today(), "llm", 25) // 25 × 4 = 100 credits

    const res = await app.request(
      "/api/v1/usage/org/1/credits",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    const body = (await res.json()) as {
      day: { totalCredits: number }
      remaining: { daily: number }
    }
    expect(body.day.totalCredits).toBe(100)
    expect(body.remaining.daily).toBe(900) // 1000 cap − 100 spend
  })
})

describe("GET /api/v2/admin/credits/orgs", () => {
  it("403 for non-admin — intent: platform-admin gate must cover credit config list", async () => {
    await seedUser(1, "wendi")
    const res = await app.request(
      "/api/v2/admin/credits/orgs",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("returns orgs with spend + caps for platform-admin — intent: admin oversight requires all-org visibility", async () => {
    await seedOrgAndAdmin()
    await insertRawRow(1, 1, today(), "agent", 10) // 10 × 5 = 50 credits

    const res = await app.request(
      "/api/v2/admin/credits/orgs",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgs: Array<{
        orgId: number
        config: { dailyCap: number; agentMarkup: number }
        day: { totalCredits: number; agentCredits: number }
        week: { totalCredits: number }
      }>
    }
    const org1 = body.orgs.find((o) => o.orgId === 1)
    expect(org1).toBeDefined()
    expect(org1?.config.dailyCap).toBe(1000)
    expect(org1?.config.agentMarkup).toBe(5)
    expect(org1?.day.agentCredits).toBe(50)
    expect(org1?.week.totalCredits).toBe(50)
  })
})

describe("PATCH /api/v2/admin/credits/org/:orgId", () => {
  it("403 for non-admin — intent: only platform-admin can change credit config", async () => {
    await seedUser(1, "wendi")
    const res = await app.request(
      "/api/v2/admin/credits/org/1",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("wendi")),
        body: JSON.stringify({ enforce: true }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("writes org_settings.credits and returns the updated config — intent: admin PATCH must persist for subsequent reads", async () => {
    await seedOrgAndAdmin()

    const res = await app.request(
      "/api/v2/admin/credits/org/1",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("root")),
        body: JSON.stringify({ enforce: true, dailyCap: 500, showToOrg: true }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orgId: number; credits: { enforce: boolean; dailyCap: number; showToOrg: boolean } }
    expect(body.orgId).toBe(1)
    expect(body.credits.enforce).toBe(true)
    expect(body.credits.dailyCap).toBe(500)
    expect(body.credits.showToOrg).toBe(true)

    // Verify the value is actually persisted by re-reading via resolveCreditConfig.
    const cfg = await resolveCreditConfig(env, env.AQUILLA_PG, 1)
    expect(cfg.enforce).toBe(true)
    expect(cfg.dailyCap).toBe(500)
    expect(cfg.showToOrg).toBe(true)
  })

  it("partial PATCH: preserves untouched fields — intent: PATCH must not clobber unrelated credit settings", async () => {
    await seedOrgAndAdmin()
    // First PATCH: set markup.
    await app.request(
      "/api/v2/admin/credits/org/1",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("root")),
        body: JSON.stringify({ markup: 3 }),
      },
      env,
    )

    // Second PATCH: set enforce only — markup must survive.
    await app.request(
      "/api/v2/admin/credits/org/1",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("root")),
        body: JSON.stringify({ enforce: true }),
      },
      env,
    )

    const cfg = await resolveCreditConfig(env, env.AQUILLA_PG, 1)
    expect(cfg.markup).toBe(3)     // from first PATCH
    expect(cfg.enforce).toBe(true) // from second PATCH
  })

  it("creates org_settings row when none exists — intent: upsert must work for orgs with no prior settings", async () => {
    // Org 2 has no org_settings row.
    await seedUser(7, "root")
    await seedUser(3, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'NWT', 3)",
    ).run()

    const res = await app.request(
      "/api/v2/admin/credits/org/2",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("root")),
        body: JSON.stringify({ dailyCap: 200 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const cfg = await resolveCreditConfig(env, env.AQUILLA_PG, 2)
    expect(cfg.dailyCap).toBe(200)
  })
})
