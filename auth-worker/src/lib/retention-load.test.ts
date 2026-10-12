// AQU-1867: the retention numbers are aggregated in Postgres now, so these run
// the real SQL (PGlite, through the production shim) and assert it agrees with
// `computeRetention` — the readable definition of every window rule — row for
// row. Parity is the contract: the dashboard and the recap email must show the
// same figures operators were tracking before the aggregation moved into SQL.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { computeRetention, type ActivityRow, type RetentionInput, type SignupRow } from "./retention"
import { loadRetentionMetrics, type LoadRetentionOptions } from "./retention-load"
import type { Env } from "../types"

// ADMIN_EMAILS is pinned to "root@example.com" in pg-test-env, so this account
// is the platform operator and must be excluded from every figure.
const ADMIN_ID = 99

const act = (userId: number, ...days: string[]): ActivityRow[] => days.map((day) => ({ userId, day }))

async function seed(users: SignupRow[], activity: ActivityRow[]): Promise<void> {
  for (const u of users) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO users (id, username, email, password_hash, preferences, created_at)
       VALUES (?, ?, ?, 'scrypt:fake$salt$hash', '{}', ?::timestamptz)`,
    )
      .bind(
        u.id,
        u.id === ADMIN_ID ? "root" : `u${u.id}`,
        u.id === ADMIN_ID ? "root@example.com" : `u${u.id}@example.com`,
        // Midday UTC: the loader reads the signup day AT TIME ZONE 'UTC', so
        // this pins the same calendar day whatever the session timezone is.
        `${u.createdAt}T12:00:00Z`,
      )
      .run()
  }
  for (const a of activity) {
    await env.AQUILLA_PG.prepare("INSERT INTO user_activity_days (user_id, day) VALUES (?, ?::date)")
      .bind(a.userId, a.day)
      .run()
  }
}

/**
 * Seed the rows, then assert the SQL loader and the reference implementation
 * produce identical metrics. Returns the metrics so a test can also pin the
 * absolute numbers it cares about.
 */
async function parity(
  input: Omit<RetentionInput, "excludeUserIds"> & LoadRetentionOptions,
): Promise<ReturnType<typeof computeRetention>> {
  await seed(input.users, input.activity)
  const { asOf, days, cohortWeeks } = input
  const fromSql = await loadRetentionMetrics(env as unknown as Env, { asOf, days, cohortWeeks })
  const fromDefinition = computeRetention({ ...input, excludeUserIds: [ADMIN_ID] })
  expect(fromSql).toEqual(fromDefinition)
  return fromSql
}

describe("loadRetentionMetrics — SQL aggregation matches the definitions", () => {
  it("active-user windows, operator exclusion and the zero-filled daily series", async () => {
    const m = await parity({
      asOf: "2026-09-12",
      days: 30,
      users: [
        { id: 1, createdAt: "2026-01-01" },
        { id: 2, createdAt: "2026-01-01" },
        { id: 3, createdAt: "2026-01-01" },
        { id: ADMIN_ID, createdAt: "2026-01-01" },
      ],
      activity: [
        ...act(1, "2026-09-12", "2026-09-11", "2026-09-10"),
        ...act(2, "2026-09-05"), // inside MAU, outside the 7-day window
        ...act(3, "2026-08-13"), // outside MAU
        ...act(ADMIN_ID, "2026-09-12"), // operator — must not count
      ],
    })
    expect(m).toMatchObject({ dau: 1, wau: 1, mau: 2, totalUsers: 3 })
    expect(m.avgDau7).toBeCloseTo(3 / 7)
    expect(m.daily).toHaveLength(30)
    expect(m.daily.at(-1)).toEqual({ day: "2026-09-12", active: 1 })
  })

  it("ignores activity after asOf and activity for users that no longer exist", async () => {
    const m = await parity({
      asOf: "2026-09-10",
      days: 30,
      users: [{ id: 1, createdAt: "2026-01-01" }],
      activity: [
        ...act(1, "2026-09-11", "2026-09-12"), // after asOf
        ...act(404, "2026-09-10"), // no users row (the rollup has no FK)
      ],
    })
    expect(m).toMatchObject({ dau: 0, mau: 0, stickiness: null })
  })

  it("Day-N counts a user retained on day N if active on day N or any later day", async () => {
    const m = await parity({
      asOf: "2026-09-12",
      days: 30,
      users: [
        { id: 1, createdAt: "2026-08-01" }, // active on d1 exactly
        { id: 2, createdAt: "2026-08-01" }, // active only on d20 → counts for d1 and d7
        { id: 3, createdAt: "2026-08-01" }, // signup-day activity only → churned
        { id: 4, createdAt: "2026-09-12" }, // signed up today → not eligible for d1
      ],
      activity: [
        ...act(1, "2026-08-02"),
        ...act(2, "2026-08-21"),
        ...act(3, "2026-08-01"),
        ...act(4, "2026-09-12"),
      ],
    })
    expect(m.retention.d1).toEqual({ eligible: 3, retained: 2, rate: 2 / 3 })
    expect(m.retention.d7).toEqual({ eligible: 3, retained: 1, rate: 1 / 3 })
    expect(m.retention.d30).toEqual({ eligible: 3, retained: 0, rate: 0 })
  })

  it("reports an empty Day-N bucket as a null rate rather than dropping it", async () => {
    const m = await parity({
      asOf: "2026-09-12",
      days: 30,
      users: [{ id: 1, createdAt: "2026-09-05" }],
      activity: act(1, "2026-09-12"),
    })
    expect(m.retention.d7).toEqual({ eligible: 1, retained: 1, rate: 1 })
    expect(m.retention.d30).toEqual({ eligible: 0, retained: 0, rate: null })
  })

  it("buckets cohorts by Monday-aligned signup week, zero-filling weeks with no signups", async () => {
    const m = await parity({
      asOf: "2026-09-12", // Saturday; the current week starts Mon 2026-09-07
      days: 30,
      cohortWeeks: 3,
      users: [
        { id: 1, createdAt: "2026-08-24" }, // cohort week Aug 24–30
        { id: 2, createdAt: "2026-08-30" }, // same cohort (Sunday)
        { id: 3, createdAt: "2026-09-08" }, // current week
        { id: ADMIN_ID, createdAt: "2026-08-24" }, // operator — not a cohort member
      ],
      activity: [
        ...act(1, "2026-08-24", "2026-09-01", "2026-09-09"), // w0, w1, w2
        ...act(2, "2026-08-30"), // w0 only
        ...act(3, "2026-09-08"),
        ...act(ADMIN_ID, "2026-08-24", "2026-09-01"),
      ],
    })
    expect(m.cohorts).toEqual([
      { weekStart: "2026-08-24", size: 2, retained: [2, 1, 1] },
      { weekStart: "2026-08-31", size: 0, retained: [0, 0] },
      { weekStart: "2026-09-07", size: 1, retained: [1] },
    ])
  })

  it("counts a cohort member once per week however many days they were active", async () => {
    const m = await parity({
      asOf: "2026-09-12",
      days: 30,
      cohortWeeks: 1,
      users: [{ id: 1, createdAt: "2026-09-07" }],
      activity: act(1, "2026-09-07", "2026-09-08", "2026-09-09"),
    })
    expect(m.cohorts[0].retained).toEqual([1])
  })

  it("returns the empty-database shape instead of throwing", async () => {
    const m = await parity({ asOf: "2026-09-12", days: 30, users: [], activity: [] })
    expect(m).toMatchObject({ dau: 0, wau: 0, mau: 0, totalUsers: 0, stickiness: null })
    expect(m.cohorts).toHaveLength(12)
  })
})
