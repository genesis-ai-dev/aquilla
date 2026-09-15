import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { bumpOrgActivity } from "../services/org-permissions"
import { sendScheduledRetentionReport } from "../lib/retention-cron"
import type { Env } from "../types"

// ADMIN_EMAILS is pinned to "root@example.com" (pg-test-env), so "root" is the
// platform admin and must be EXCLUDED from the retention figures.

async function seedActivity(userId: number, ...days: string[]): Promise<void> {
  for (const day of days) {
    await env.AQUILLA_PG.prepare("INSERT INTO user_activity_days (user_id, day) VALUES (?, ?)")
      .bind(userId, day)
      .run()
  }
}

describe("GET /api/v2/admin/retention", () => {
  it("computes active users + cohorts from user_activity_days, excluding platform admins", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await seedUser(2, "amos")
    // Pin signups so cohorts are deterministic relative to ?asOf.
    await env.AQUILLA_PG.prepare("UPDATE users SET created_at = '2026-09-01T10:00:00Z' WHERE id IN (1, 2)").run()
    await seedActivity(1, "2026-09-01", "2026-09-10")
    await seedActivity(2, "2026-09-01")
    await seedActivity(7, "2026-09-10") // admin — must not count

    const res = await app.request(
      "/api/v2/admin/retention?asOf=2026-09-10&days=30",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      asOf: string
      dau: number
      wau: number
      mau: number
      totalUsers: number
      retention: { d7: { eligible: number; retained: number } }
      daily: Array<{ day: string; active: number }>
      cohorts: Array<{ weekStart: string; size: number; retained: number[] }>
    }
    expect(body.asOf).toBe("2026-09-10")
    expect(body.dau).toBe(1) // wendi only; root excluded
    expect(body.wau).toBe(1)
    expect(body.mau).toBe(2)
    expect(body.totalUsers).toBe(2)
    expect(body.retention.d7).toMatchObject({ eligible: 2, retained: 1 })
    expect(body.daily).toHaveLength(30)
    expect(body.daily.at(-1)).toEqual({ day: "2026-09-10", active: 1 })
    // Signup week of Mon 2026-08-31: both users, one still active the following week.
    const cohort = body.cohorts.find((c) => c.weekStart === "2026-08-31")
    expect(cohort).toMatchObject({ size: 2, retained: [2, 1] })
  })

  it("rejects an out-of-range ?days", async () => {
    await seedUser(7, "root")
    const res = await app.request(
      "/api/v2/admin/retention?days=5",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(400)
  })

  it("403s a non-admin", async () => {
    await seedUser(1, "wendi")
    const res = await app.request("/api/v2/admin/retention", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(403)
  })
})

describe("bumpOrgActivity → user_activity_days", () => {
  it("records today's activity day once, even when the org bump is debounced", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by, last_active_at) VALUES (1, 1, 700, 1, now())",
    ).run()
    // last_active_at is fresh → the UPDATE's WHERE won't match; the day row must still land.
    await bumpOrgActivity(env as unknown as Env, 1, 1)
    const rows = await env.AQUILLA_PG.prepare(
      "SELECT user_id, to_char(day, 'YYYY-MM-DD') AS day FROM user_activity_days",
    ).all<{ user_id: number; day: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0].day).toBe(new Date().toISOString().slice(0, 10))
  })
})

describe("POST /api/v2/admin/retention/report", () => {
  it("503s when EMAIL is not bound", async () => {
    await seedUser(7, "root")
    const res = await app.request(
      "/api/v2/admin/retention/report",
      {
        method: "POST",
        headers: authHeader(await jwtFor("root")),
        body: JSON.stringify({ period: "weekly" }),
      },
      env,
    )
    expect(res.status).toBe(503)
  })

  it("emails the weekly recap to the caller when EMAIL is bound", async () => {
    await seedUser(7, "root")
    const send = vi.fn<(message: unknown) => Promise<{ messageId: string }>>(async () => ({ messageId: "m1" }))
    const withEmail = { ...env, EMAIL: { send } }
    const res = await app.request(
      "/api/v2/admin/retention/report",
      {
        method: "POST",
        headers: authHeader(await jwtFor("root")),
        body: JSON.stringify({ period: "weekly" }),
      },
      withEmail,
    )
    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    const msg = send.mock.calls[0][0] as { to: string[]; subject: string }
    expect(msg.to).toEqual(["root@example.com"])
    expect(msg.subject).toMatch(/Aquilla retention — week ending \d{4}-\d{2}-\d{2}/)
  })
})

describe("sendScheduledRetentionReport (cron)", () => {
  it("ignores non-recap crons and refuses to send outside production", async () => {
    const e = env as unknown as Env
    expect(await sendScheduledRetentionReport(e, "*/5 * * * *", new Date())).toBe("not-a-recap-cron")
    expect(await sendScheduledRetentionReport({ ...e, ENVIRONMENT: "development" }, "0 14 * * 1", new Date())).toBe(
      "skipped-non-production",
    )
  })

  it("sends the monthly recap to every ADMIN_EMAILS entry in production", async () => {
    await seedUser(7, "root")
    const send = vi.fn<(message: unknown) => Promise<{ messageId: string }>>(async () => ({ messageId: "m1" }))
    const e = { ...(env as unknown as Env), ENVIRONMENT: "production", EMAIL: { send } }
    expect(await sendScheduledRetentionReport(e, "0 14 1 * *", new Date("2026-10-01T14:00:00Z"))).toBe("sent-monthly")
    const msg = send.mock.calls[0][0] as { to: string[]; subject: string; text: string }
    expect(msg.to).toEqual(["root@example.com"])
    expect(msg.subject).toBe("Aquilla retention — month ending 2026-09-30")
    expect(msg.text).toContain("Dashboard: https://aquilla.app/admin")
  })
})
