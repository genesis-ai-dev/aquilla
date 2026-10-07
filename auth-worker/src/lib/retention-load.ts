// DB → computeRetention. The one place that knows which tables feed the
// retention numbers; the admin route and the cron recap both call this so
// they can never drift apart.

import type { Env } from "../types"
import { parseAdminEmails } from "../middleware/platform-admin"
import { computeRetention, type RetentionMetrics } from "./retention"

/** Enough history for a 12-week cohort matrix plus the 365-day Day-N pool + 30. */
const ACTIVITY_LOOKBACK_DAYS = 400

export interface LoadRetentionOptions {
  /** 'YYYY-MM-DD' inclusive window end. Defaults to today (UTC). */
  asOf?: string
  days?: number
  cohortWeeks?: number
}

/**
 * Load signups + activity days and compute the metrics. Platform operators
 * (ADMIN_EMAILS) are excluded so the team poking at the console doesn't show
 * up as retained users.
 */
export async function loadRetentionMetrics(
  env: Env,
  opts: LoadRetentionOptions = {},
): Promise<RetentionMetrics> {
  const db = env.AQUILLA_PG
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const adminEmails = Array.from(parseAdminEmails(env))

  const [users, activity, admins] = await Promise.all([
    db
      .prepare(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created_at FROM users`,
      )
      .all<{ id: number; created_at: string }>(),
    db
      .prepare(
        `SELECT user_id, to_char(day, 'YYYY-MM-DD') AS day
           FROM user_activity_days
          WHERE day >= CURRENT_DATE - ${ACTIVITY_LOOKBACK_DAYS}`,
      )
      .all<{ user_id: number; day: string }>(),
    adminEmails.length > 0
      ? db
          .prepare(
            `SELECT id FROM users WHERE LOWER(email) IN (${adminEmails.map(() => "?").join(", ")})`,
          )
          .bind(...adminEmails)
          .all<{ id: number }>()
      : Promise.resolve({ results: [] as Array<{ id: number }> }),
  ])

  return computeRetention({
    asOf,
    days: opts.days,
    cohortWeeks: opts.cohortWeeks,
    users: users.results.map((r) => ({ id: Number(r.id), createdAt: r.created_at })),
    activity: activity.results.map((r) => ({ userId: Number(r.user_id), day: r.day })),
    excludeUserIds: admins.results.map((r) => Number(r.id)),
  })
}
