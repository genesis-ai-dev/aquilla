import { describe, expect, it } from "vitest"
import { fmtLabeledDateTime, fmtShortCalendarDate } from "./format-date"

const NOW = new Date(2026, 6, 9).getTime()
const RECENT = new Date(2026, 6, 3, 13, 37, 8)
const OLD = new Date(2024, 7, 18, 19, 41, 7)

describe("fmtShortCalendarDate", () => {
  it("formats a recent timestamp as month + day", () => {
    expect(fmtShortCalendarDate(RECENT.getTime(), NOW)).toBe(
      RECENT.toLocaleDateString(undefined, { month: "long", day: "numeric" }),
    )
  })

  it("formats a timestamp older than a year as short month + year", () => {
    expect(fmtShortCalendarDate(OLD.getTime(), NOW)).toBe(
      OLD.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
    )
  })

  it("returns em dash for null", () => {
    expect(fmtShortCalendarDate(null, NOW)).toBe("—")
  })
})

describe("fmtLabeledDateTime", () => {
  it("prefixes a recent datetime without year", () => {
    const when = RECENT.toLocaleString(undefined, {
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    })
    expect(fmtLabeledDateTime(RECENT.getTime(), "Edited", NOW)).toBe(`Edited ${when}`)
  })

  it("prefixes an older datetime with year", () => {
    const when = OLD.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    })
    expect(fmtLabeledDateTime(OLD.getTime(), "Archived", NOW)).toBe(`Archived ${when}`)
  })
})
