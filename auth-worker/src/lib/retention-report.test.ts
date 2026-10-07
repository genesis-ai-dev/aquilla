// Guards the recap's cadence windows (which days a Monday / 1st-of-month send
// compares) and that the email states the numbers it was given — an operator
// acting on a "+4 WAU" line needs that line to be the actual delta.

import { describe, it, expect } from "vitest"
import { buildRetentionReport, reportWindow } from "./retention-report"
import { computeRetention } from "./retention"

describe("reportWindow", () => {
  it("weekly compares the last complete day against 7 days earlier", () => {
    // Monday 2026-09-14 14:00 UTC → week ending Sunday 09-13 vs Sunday 09-06.
    expect(reportWindow("weekly", new Date("2026-09-14T14:00:00Z"))).toEqual({
      asOf: "2026-09-13",
      previous: "2026-09-06",
    })
  })

  it("monthly reports the previous calendar month against 30 days earlier", () => {
    expect(reportWindow("monthly", new Date("2026-10-01T14:00:00Z"))).toEqual({
      asOf: "2026-09-30",
      previous: "2026-08-31",
    })
  })
})

describe("buildRetentionReport", () => {
  const users = [
    { id: 1, createdAt: "2026-08-24" },
    { id: 2, createdAt: "2026-09-08" },
  ]
  const activity = [
    { userId: 1, day: "2026-08-24" },
    { userId: 1, day: "2026-09-02" },
    { userId: 1, day: "2026-09-12" },
    { userId: 2, day: "2026-09-08" },
    { userId: 2, day: "2026-09-13" },
  ]
  const current = computeRetention({ asOf: "2026-09-13", users, activity })
  const previous = computeRetention({ asOf: "2026-09-06", users, activity })

  it("prefixes the subject outside production and states the WAU delta", () => {
    const r = buildRetentionReport({
      period: "weekly",
      current,
      previous,
      environment: "development",
      dashboardUrl: null,
    })
    expect(r.subject).toBe("[development] Aquilla retention — week ending 2026-09-13")
    // WAU: both users active Sep 7–13 (=2) vs only user 1 active Aug 31–Sep 6 (=1).
    expect(r.text).toContain("Weekly active (WAU)")
    expect(r.text).toMatch(/Weekly active \(WAU\)\s+2\s+\+1 vs prior/)
    expect(r.text).toContain("New users (7d)")
    expect(r.html).toContain("Weekly active (WAU)")
    expect(r.text).not.toContain("Dashboard:")
  })

  it("links the dashboard in production and uses 30-day signups for the monthly recap", () => {
    const r = buildRetentionReport({
      period: "monthly",
      current,
      previous,
      environment: "production",
      dashboardUrl: "https://aquilla.app/admin",
    })
    expect(r.subject).toBe("Aquilla retention — month ending 2026-09-13")
    expect(r.text).toContain("New users (30d)")
    expect(r.text).toContain("Dashboard: https://aquilla.app/admin")
    expect(r.html).toContain('href="https://aquilla.app/admin"')
  })

  it("escapes HTML in the rendered email", () => {
    const r = buildRetentionReport({
      period: "weekly",
      current,
      previous,
      environment: "production",
      dashboardUrl: 'https://x/"><script>',
    })
    expect(r.html).not.toContain("<script>")
    expect(r.html).toContain("&quot;&gt;&lt;script&gt;")
  })
})
