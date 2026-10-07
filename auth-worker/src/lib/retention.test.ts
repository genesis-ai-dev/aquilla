// These pin the DEFINITIONS the admin dashboard and the emailed recap share.
// If a window boundary, the unbounded Day-N rule, or the Monday cohort
// alignment changes, the numbers operators have been tracking silently shift
// — so each test names the rule it guards.

import { describe, it, expect } from "vitest"
import { computeRetention, dayIndex, isoDay, weekStartIndex } from "./retention"

const act = (userId: number, ...days: string[]) => days.map((day) => ({ userId, day }))

describe("day helpers", () => {
  it("round-trips ISO days and aligns weeks to Monday", () => {
    expect(isoDay(dayIndex("2026-09-12"))).toBe("2026-09-12")
    // 2026-09-12 is a Saturday; its week started Monday 2026-09-07.
    expect(isoDay(weekStartIndex(dayIndex("2026-09-12")))).toBe("2026-09-07")
    expect(isoDay(weekStartIndex(dayIndex("2026-09-07")))).toBe("2026-09-07")
    expect(isoDay(weekStartIndex(dayIndex("2026-09-06")))).toBe("2026-08-31")
  })
})

describe("computeRetention — active-user windows", () => {
  it("DAU/WAU/MAU are distinct users in inclusive windows ending asOf", () => {
    const m = computeRetention({
      asOf: "2026-09-12",
      users: [
        { id: 1, createdAt: "2026-01-01" },
        { id: 2, createdAt: "2026-01-01" },
        { id: 3, createdAt: "2026-01-01" },
      ],
      activity: [
        ...act(1, "2026-09-12", "2026-09-11", "2026-09-10"), // today + twice this week
        ...act(2, "2026-09-05"), // 7 days before asOf → outside the 7-day window, inside MAU
        ...act(3, "2026-08-13"), // 30 days ago → outside MAU (window is 30 days incl. asOf)
      ],
    })
    expect(m.dau).toBe(1)
    expect(m.wau).toBe(1)
    expect(m.mau).toBe(2)
    expect(m.avgDau7).toBeCloseTo(3 / 7)
    expect(m.stickiness).toBeCloseTo(3 / 7 / 2)
  })

  it("ignores activity after asOf so a back-dated report is reproducible", () => {
    const m = computeRetention({
      asOf: "2026-09-10",
      users: [{ id: 1, createdAt: "2026-01-01" }],
      activity: act(1, "2026-09-11", "2026-09-12"),
    })
    expect(m.dau).toBe(0)
    expect(m.mau).toBe(0)
    expect(m.stickiness).toBeNull()
  })

  it("excludes listed users (platform operators) from every figure", () => {
    const m = computeRetention({
      asOf: "2026-09-12",
      users: [
        { id: 1, createdAt: "2026-09-12" },
        { id: 9, createdAt: "2026-09-12" },
      ],
      activity: [...act(1, "2026-09-12"), ...act(9, "2026-09-12")],
      excludeUserIds: [9],
    })
    expect(m.dau).toBe(1)
    expect(m.newUsers7).toBe(1)
    expect(m.totalUsers).toBe(1)
    expect(m.cohorts.at(-1)).toMatchObject({ size: 1, retained: [1] })
  })

  it("zero-fills the daily series, oldest first, ending at asOf", () => {
    const m = computeRetention({
      asOf: "2026-09-12",
      days: 3,
      users: [{ id: 1, createdAt: "2026-01-01" }],
      activity: act(1, "2026-09-11"),
    })
    expect(m.daily).toEqual([
      { day: "2026-09-10", active: 0 },
      { day: "2026-09-11", active: 1 },
      { day: "2026-09-12", active: 0 },
    ])
  })
})

describe("computeRetention — Day-N (unbounded)", () => {
  it("counts a user retained on day N if active on day N OR any later day", () => {
    const m = computeRetention({
      asOf: "2026-09-12",
      users: [
        { id: 1, createdAt: "2026-08-01" }, // active on d1 exactly
        { id: 2, createdAt: "2026-08-01" }, // active only on d20 → still counts for d1 and d7
        { id: 3, createdAt: "2026-08-01" }, // only signup-day activity → churned
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

  it("requires signup + N <= asOf for eligibility (a user can't have churned on a day that hasn't happened)", () => {
    const m = computeRetention({
      asOf: "2026-09-12",
      users: [{ id: 1, createdAt: "2026-09-05" }], // 7 days ago → eligible for d7, not d30
      activity: act(1, "2026-09-12"),
    })
    expect(m.retention.d7).toEqual({ eligible: 1, retained: 1, rate: 1 })
    expect(m.retention.d30).toEqual({ eligible: 0, retained: 0, rate: null })
  })
})

describe("computeRetention — weekly cohorts", () => {
  it("buckets signups by Monday-aligned week and reports only weeks that have started", () => {
    const m = computeRetention({
      asOf: "2026-09-12", // Saturday; current week starts 2026-09-07
      cohortWeeks: 3,
      users: [
        { id: 1, createdAt: "2026-08-24" }, // cohort week 1 (Aug 24–30)
        { id: 2, createdAt: "2026-08-30" }, // same cohort (Sunday)
        { id: 3, createdAt: "2026-09-08" }, // current week
      ],
      activity: [
        ...act(1, "2026-08-24", "2026-09-01", "2026-09-09"), // w0, w1, w2
        ...act(2, "2026-08-30"), // w0 only
        ...act(3, "2026-09-08"),
      ],
    })
    expect(m.cohorts.map((c) => c.weekStart)).toEqual(["2026-08-24", "2026-08-31", "2026-09-07"])
    expect(m.cohorts[0]).toEqual({ weekStart: "2026-08-24", size: 2, retained: [2, 1, 1] })
    expect(m.cohorts[1]).toEqual({ weekStart: "2026-08-31", size: 0, retained: [0, 0] })
    expect(m.cohorts[2]).toEqual({ weekStart: "2026-09-07", size: 1, retained: [1] })
  })

  it("counts a member once per week however many days they were active", () => {
    const m = computeRetention({
      asOf: "2026-09-12",
      cohortWeeks: 1,
      users: [{ id: 1, createdAt: "2026-09-07" }],
      activity: act(1, "2026-09-07", "2026-09-08", "2026-09-09"),
    })
    expect(m.cohorts[0].retained).toEqual([1])
  })
})
