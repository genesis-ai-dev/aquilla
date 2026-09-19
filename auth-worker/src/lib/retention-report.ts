// The emailed retention recap. Pure: takes the metrics for the period end and
// for the comparison point, returns subject + text + html. Sent by the cron in
// index.ts (weekly Monday / monthly on the 1st) and on demand from the admin
// console ("Email me this report").
//
// Cadence rationale: daily numbers belong on the dashboard (too noisy to
// email at our cohort sizes); the weekly recap is the operating rhythm; the
// monthly recap is where the retention curve shape is actually readable.

import { dayIndex, isoDay, type RetentionMetrics, type WeeklyCohort } from "./retention"

export type ReportPeriod = "weekly" | "monthly"

export interface RetentionReport {
  subject: string
  text: string
  html: string
}

/** Last complete UTC day before `now`. */
export function lastCompleteDay(now: Date): string {
  return isoDay(dayIndex(now.toISOString().slice(0, 10)) - 1)
}

/** Which as-of / comparison days a period compares. */
export function reportWindow(period: ReportPeriod, now: Date): { asOf: string; previous: string } {
  if (period === "weekly") {
    const asOf = lastCompleteDay(now)
    return { asOf, previous: isoDay(dayIndex(asOf) - 7) }
  }
  // Monthly: the last day of the previous calendar month, vs 30 days before it.
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const asOf = isoDay(dayIndex(first.toISOString().slice(0, 10)) - 1)
  return { asOf, previous: isoDay(dayIndex(asOf) - 30) }
}

const pct = (rate: number | null): string => (rate == null ? "—" : `${Math.round(rate * 100)}%`)
const delta = (cur: number, prev: number): string => {
  const d = cur - prev
  if (d === 0) return "no change"
  return `${d > 0 ? "+" : ""}${Number.isInteger(d) ? d : d.toFixed(1)} vs prior`
}
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

interface Line {
  label: string
  value: string
  note?: string
}

function cohortLine(c: WeeklyCohort): Line {
  const share = (k: number): string =>
    c.retained.length > k && c.size > 0 ? pct(c.retained[k] / c.size) : "—"
  return {
    label: `Week of ${c.weekStart}`,
    value: `${c.size} signup${c.size === 1 ? "" : "s"}`,
    note: `w1 ${share(1)} · w2 ${share(2)} · w4 ${share(4)}`,
  }
}

export function buildRetentionReport(input: {
  period: ReportPeriod
  current: RetentionMetrics
  previous: RetentionMetrics
  /** e.g. "production"; shown in the subject so a dev-stack send is obvious. */
  environment: string
  /** Absolute link to the admin console, or null to omit. */
  dashboardUrl: string | null
}): RetentionReport {
  const { period, current: cur, previous: prev } = input
  const title =
    period === "weekly"
      ? `Aquilla retention — week ending ${cur.asOf}`
      : `Aquilla retention — month ending ${cur.asOf}`
  const subject = input.environment === "production" ? title : `[${input.environment}] ${title}`

  const sections: Array<{ heading: string; lines: Line[] }> = [
    {
      heading: "Active users",
      lines: [
        { label: "Weekly active (WAU)", value: String(cur.wau), note: delta(cur.wau, prev.wau) },
        { label: "Monthly active (MAU)", value: String(cur.mau), note: delta(cur.mau, prev.mau) },
        { label: "Avg daily active (7d)", value: num(cur.avgDau7), note: delta(cur.avgDau7, prev.avgDau7) },
        { label: "Stickiness (avg DAU / MAU)", value: pct(cur.stickiness), note: `prior ${pct(prev.stickiness)}` },
      ],
    },
    {
      heading: "Signups & retention",
      lines: [
        {
          label: period === "weekly" ? "New users (7d)" : "New users (30d)",
          value: String(period === "weekly" ? cur.newUsers7 : cur.newUsers30),
          note: delta(
            period === "weekly" ? cur.newUsers7 : cur.newUsers30,
            period === "weekly" ? prev.newUsers7 : prev.newUsers30,
          ),
        },
        { label: "Total users", value: String(cur.totalUsers) },
        {
          label: "Day-7 retention",
          value: pct(cur.retention.d7.rate),
          note: `${cur.retention.d7.retained} of ${cur.retention.d7.eligible} eligible · prior ${pct(prev.retention.d7.rate)}`,
        },
        {
          label: "Day-30 retention",
          value: pct(cur.retention.d30.rate),
          note: `${cur.retention.d30.retained} of ${cur.retention.d30.eligible} eligible · prior ${pct(prev.retention.d30.rate)}`,
        },
      ],
    },
    {
      heading: "Signup cohorts (share active in week N after signup)",
      lines: cur.cohorts
        .slice(period === "weekly" ? -6 : -12)
        .reverse()
        .map(cohortLine),
    },
  ]

  const footer =
    "Platform admins are excluded from every figure. Days are UTC. Day-N retention is unbounded (active on day N or any later day)."

  const text = [
    title,
    "",
    ...sections.flatMap((s) => [
      s.heading,
      ...s.lines.map((l) => `  ${l.label.padEnd(28)} ${l.value.padStart(6)}${l.note ? `   ${l.note}` : ""}`),
      "",
    ]),
    input.dashboardUrl ? `Dashboard: ${input.dashboardUrl}` : "",
    footer,
  ]
    .join("\n")
    .trim()

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937">
    <h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(title)}</h2>
    ${sections
      .map(
        (s) => `
    <h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">${escapeHtml(s.heading)}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      ${s.lines
        .map(
          (l) => `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(l.label)}</td>
        <td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${escapeHtml(l.value)}</td>
        <td style="padding:6px 0 6px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px">${escapeHtml(l.note ?? "")}</td>
      </tr>`,
        )
        .join("")}
    </table>`,
      )
      .join("")}
    ${input.dashboardUrl ? `<p style="margin:20px 0 8px"><a href="${escapeHtml(input.dashboardUrl)}" style="color:#2563eb">Open the retention dashboard</a></p>` : ""}
    <p style="margin:12px 0 0;font-size:12px;color:#6b7280">${escapeHtml(footer)}</p>
  </div>`

  return { subject, text, html }
}
