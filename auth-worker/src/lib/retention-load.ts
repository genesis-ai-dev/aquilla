// DB → retention metrics. The one place that knows which tables feed the
// retention numbers; the admin route and the cron recap both call this so
// they can never drift apart.
//
// AQU-1867: every aggregate here is computed in Postgres. The first version of
// this loader pulled `users` (unbounded) plus 400 days of `user_activity_days`
// into the isolate and reduced them in JS — around 1.2M row objects at ~3k
// daily-active users, which walks into the Worker's 128 MB limit and then the
// weekly recap email silently stops going out. What the isolate now holds is
// aggregated rows only: one per day of the daily series (<= 365), one per
// (cohort week x week offset) pair (<= 144), one per Day-N bucket, and two
// single-row count results.
//
// `computeRetention` in ./retention remains the executable definition of these
// numbers (and documents every window rule); retention-load.test.ts seeds
// Postgres and asserts this loader agrees with it row for row, so the SQL
// below cannot drift from the definitions operators have been tracking.

import type { Env } from "../types"
import { loadPlatformAdminEmails } from "../middleware/platform-admin"
import {
  dayIndex,
  isoDay,
  weekStartIndex,
  type DayNRetention,
  type RetentionMetrics,
  type WeeklyCohort,
} from "./retention"

/** Only users who signed up within this many days of `asOf` enter the Day-N pools. */
const DAY_N_LOOKBACK = 365
/** The Day-N buckets the dashboard and the recap report. */
const DAY_N_OFFSETS = [1, 7, 30] as const

export interface LoadRetentionOptions {
  /** 'YYYY-MM-DD' inclusive window end. Defaults to today (UTC). */
  asOf?: string
  days?: number
  cohortWeeks?: number
}

const count = (v: unknown): number => Number(v ?? 0)

/**
 * Load the metrics. Platform operators (ADMIN_EMAILS + `platform_admins`) are
 * excluded so the team poking at the console doesn't show up as retained users.
 */
export async function loadRetentionMetrics(
  env: Env,
  opts: LoadRetentionOptions = {},
): Promise<RetentionMetrics> {
  const db = env.AQUILLA_PG
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const days = opts.days ?? 90
  const cohortWeeks = opts.cohortWeeks ?? 12
  const asOfIndex = dayIndex(asOf)
  const currentWeek = isoDay(weekStartIndex(asOfIndex))

  // Every query starts from the same eligible-user set: non-operator accounts
  // with their UTC signup day. Operators are dropped by email (the identity
  // platform-admin uses), which also keeps them out of the activity joins.
  const admins = Array.from(await loadPlatformAdminEmails(env))
  const elig = `WITH elig AS (
      SELECT u.id, (u.created_at AT TIME ZONE 'UTC')::date AS signup
        FROM users u
       ${admins.length > 0 ? `WHERE LOWER(u.email) NOT IN (${admins.map(() => "?").join(", ")})` : ""}
    )`

  const [series, windows, totals, dayN, cohortRows] = await Promise.all([
    // The daily series: one row per day that saw activity, zero-filled below.
    db
      .prepare(
        `${elig}
         SELECT to_char(a.day, 'YYYY-MM-DD') AS day, COUNT(DISTINCT a.user_id) AS active
           FROM user_activity_days a
           JOIN elig e ON e.id = a.user_id
          WHERE a.day BETWEEN ?::date - ?::int AND ?::date
          GROUP BY a.day`,
      )
      .bind(...admins, asOf, days - 1, asOf)
      .all<{ day: string; active: number }>(),
    // DAU / WAU / MAU plus the 7-day activity total behind avgDau7. (user_id,
    // day) is the table's primary key, so COUNT(*) over the 7-day window is
    // already the sum of the per-day distinct counts.
    db
      .prepare(
        `${elig}
         SELECT (COUNT(DISTINCT a.user_id) FILTER (WHERE a.day = ?::date)) AS dau,
                (COUNT(DISTINCT a.user_id) FILTER (WHERE a.day >= ?::date - 6)) AS wau,
                COUNT(DISTINCT a.user_id) AS mau,
                (COUNT(*) FILTER (WHERE a.day >= ?::date - 6)) AS active_days7
           FROM user_activity_days a
           JOIN elig e ON e.id = a.user_id
          WHERE a.day BETWEEN ?::date - 29 AND ?::date`,
      )
      .bind(...admins, asOf, asOf, asOf, asOf, asOf)
      .first<{ dau: number; wau: number; mau: number; active_days7: number }>(),
    // Signup counts. totalUsers is every eligible account, however old.
    db
      .prepare(
        `${elig}
         SELECT COUNT(*) FILTER (WHERE signup IS NOT NULL) AS total,
                COUNT(*) FILTER (WHERE signup BETWEEN ?::date - 6 AND ?::date) AS new7,
                COUNT(*) FILTER (WHERE signup BETWEEN ?::date - 29 AND ?::date) AS new30
           FROM elig`,
      )
      .bind(...admins, asOf, asOf, asOf, asOf)
      .first<{ total: number; new7: number; new30: number }>(),
    // Day-N, unbounded: eligible = signed up at least N days before asOf and
    // within the lookback; retained = active on day N or ANY later day.
    db
      .prepare(
        `${elig}, pool AS (
           SELECT id, signup FROM elig
            WHERE signup IS NOT NULL AND signup >= ?::date - ?::int
         )
         SELECT n.n AS offset_days,
                COUNT(*) AS eligible,
                COUNT(*) FILTER (
                  WHERE EXISTS (
                    SELECT 1 FROM user_activity_days a
                     WHERE a.user_id = p.id AND a.day >= p.signup + n.n AND a.day <= ?::date
                  )
                ) AS retained
           FROM (VALUES ${DAY_N_OFFSETS.map(() => "(?::int)").join(", ")}) AS n(n)
           JOIN pool p ON p.signup + n.n <= ?::date
          GROUP BY n.n`,
      )
      .bind(...admins, asOf, DAY_N_LOOKBACK, asOf, ...DAY_N_OFFSETS, asOf)
      .all<{ offset_days: number; eligible: number; retained: number }>(),
    // Weekly signup cohorts (Monday-aligned) x the week offsets that have
    // started by asOf. One row per (week, offset) that has cohort members.
    db
      .prepare(
        `${elig}, cohort AS (
           SELECT e.id, date_trunc('week', e.signup)::date AS wk
             FROM elig e
            WHERE e.signup >= ?::date - ?::int AND e.signup < ?::date + 7
         )
         SELECT to_char(c.wk, 'YYYY-MM-DD') AS week_start,
                k.k AS week_offset,
                COUNT(DISTINCT c.id) AS size,
                COUNT(DISTINCT a.user_id) AS retained
           FROM cohort c
           CROSS JOIN generate_series(0, ?::int) AS k(k)
           LEFT JOIN user_activity_days a
                  ON a.user_id = c.id
                 AND a.day >= c.wk + (7 * k.k)
                 AND a.day <= LEAST(c.wk + (7 * k.k) + 6, ?::date)
          WHERE c.wk + (7 * k.k) <= ?::date
          GROUP BY c.wk, k.k`,
      )
      .bind(...admins, currentWeek, 7 * (cohortWeeks - 1), currentWeek, cohortWeeks - 1, asOf, currentWeek)
      .all<{ week_start: string; week_offset: number; size: number; retained: number }>(),
  ])

  const activeByDay = new Map(series.results.map((r) => [r.day, count(r.active)]))
  const daily: RetentionMetrics["daily"] = []
  for (let d = asOfIndex - days + 1; d <= asOfIndex; d++) {
    const day = isoDay(d)
    daily.push({ day, active: activeByDay.get(day) ?? 0 })
  }

  const avgDau7 = count(windows?.active_days7) / 7
  const mau = count(windows?.mau)

  const byOffset = new Map(dayN.results.map((r) => [count(r.offset_days), r]))
  const retentionFor = (n: number): DayNRetention => {
    const row = byOffset.get(n)
    const eligible = count(row?.eligible)
    const retained = count(row?.retained)
    return { eligible, retained, rate: eligible > 0 ? retained / eligible : null }
  }

  // Zero-fill: every one of the `cohortWeeks` weeks is reported, and each week
  // only reports the offsets that have started (oldest week has the most).
  const cohortCells = new Map(
    cohortRows.results.map((r) => [`${r.week_start}:${count(r.week_offset)}`, r]),
  )
  const cohorts: WeeklyCohort[] = []
  for (let w = cohortWeeks - 1; w >= 0; w--) {
    const weekStart = isoDay(weekStartIndex(asOfIndex) - 7 * w)
    const retained: number[] = []
    for (let k = 0; k <= w; k++) {
      retained.push(count(cohortCells.get(`${weekStart}:${k}`)?.retained))
    }
    cohorts.push({
      weekStart,
      size: count(cohortCells.get(`${weekStart}:0`)?.size),
      retained,
    })
  }

  return {
    asOf: isoDay(asOfIndex),
    dau: count(windows?.dau),
    avgDau7,
    wau: count(windows?.wau),
    mau,
    stickiness: mau > 0 ? avgDau7 / mau : null,
    newUsers7: count(totals?.new7),
    newUsers30: count(totals?.new30),
    totalUsers: count(totals?.total),
    retention: { d1: retentionFor(1), d7: retentionFor(7), d30: retentionFor(30) },
    daily,
    cohorts,
  }
}
