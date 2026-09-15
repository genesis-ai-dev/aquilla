// Cron entry for the retention recap. Which schedule fired arrives as the
// cron expression string (ScheduledController.cron), so the mapping from
// expression → period lives here next to the wrangler.toml [triggers] entries.
// Production-only: dev/staging crons would otherwise mail ADMIN_EMAILS a
// recap of seed data every Monday.

import type { Env } from "../types"
import { parseAdminEmails } from "../middleware/platform-admin"
import { sendRetentionReportEmail } from "../services/email"
import { loadRetentionMetrics } from "./retention-load"
import { buildRetentionReport, reportWindow, type ReportPeriod } from "./retention-report"

export const RETENTION_CRONS: Record<string, ReportPeriod> = {
  "0 14 * * 1": "weekly",
  "0 14 1 * *": "monthly",
}

export type RetentionCronResult =
  | "not-a-recap-cron"
  | "skipped-non-production"
  | "skipped-no-recipients"
  | "email-unavailable"
  | `sent-${ReportPeriod}`

export async function sendScheduledRetentionReport(
  env: Env,
  cron: string,
  now: Date,
): Promise<RetentionCronResult> {
  const period = RETENTION_CRONS[cron]
  if (!period) return "not-a-recap-cron"
  if (env.ENVIRONMENT !== "production") return "skipped-non-production"
  const to = Array.from(parseAdminEmails(env))
  if (to.length === 0) return "skipped-no-recipients"

  const window = reportWindow(period, now)
  const [current, previous] = await Promise.all([
    loadRetentionMetrics(env, { asOf: window.asOf }),
    loadRetentionMetrics(env, { asOf: window.previous }),
  ])
  const report = buildRetentionReport({
    period,
    current,
    previous,
    environment: "production",
    dashboardUrl: "https://aquilla.app/admin",
  })
  const sent = await sendRetentionReportEmail(env, to, report)
  return sent ? `sent-${period}` : "email-unavailable"
}
