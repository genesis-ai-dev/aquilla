import { describe, expect, it } from "vitest"
import { fmtDeadlineDate, fmtLabeledDeadlineDate, fmtLabeledDateTime, fmtShortCalendarDate } from "./format-date"
import { DEFAULT_LOCALE } from "./i18n/locales"

const NOW = new Date(2026, 6, 9).getTime()
const RECENT = new Date(2026, 6, 3, 13, 37, 8)
const OLD = new Date(2024, 7, 18, 19, 41, 7)

/**
 * Expectations render through an explicit locale tag, never the host's (AQU-1315).
 *
 * These formatters render against the *app* locale — `DEFAULT_LOCALE` when the
 * caller passes none (`format-date.ts`), not `navigator.language` / the process
 * ICU default. Building the expected string with `toLocaleString(undefined, …)`
 * silently re-introduced the host default on the assertion side, so the file
 * passed only where the host happened to resolve to `en`: an `en-CA` machine
 * renders the day period as "p.m." where `en` renders "PM", and all three
 * `fmtLabeledDateTime` assertions failed. AGENTS.md ("Machine speed must not
 * decide correctness"; wait for state, not environment) applies to host
 * configuration for the same reason — a test that only passes on one machine's
 * settings is not a test of the product.
 *
 * Pinning the tag on both sides also keeps the assertions ICU-version-agnostic:
 * we compare against whatever `en` renders on this runtime rather than a frozen
 * literal like "July 3 at 1:37:08 PM", whose separator has changed across ICU
 * releases.
 */
function renderIn(locale: string, date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, options).format(date)
}

const RECENT_DETAIL_OPTS: Intl.DateTimeFormatOptions = {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
}

const OLDER_DETAIL_OPTS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
}

describe("fmtShortCalendarDate", () => {
  it("formats a recent timestamp as month + day", () => {
    expect(fmtShortCalendarDate(RECENT.getTime(), NOW)).toBe(
      renderIn(DEFAULT_LOCALE, RECENT, { month: "long", day: "numeric" }),
    )
  })

  it("formats a timestamp older than a year as short month + year", () => {
    expect(fmtShortCalendarDate(OLD.getTime(), NOW)).toBe(
      renderIn(DEFAULT_LOCALE, OLD, { month: "short", year: "numeric" }),
    )
  })

  it("returns em dash for null", () => {
    expect(fmtShortCalendarDate(null, NOW)).toBe("—")
  })

  it("renders against the locale it is given, not the host's", () => {
    expect(fmtShortCalendarDate(RECENT.getTime(), NOW, "th")).toBe(
      renderIn("th", RECENT, { month: "long", day: "numeric" }),
    )
  })
})

describe("fmtLabeledDateTime", () => {
  it("prefixes a recent datetime without year", () => {
    expect(fmtLabeledDateTime(RECENT.getTime(), "Edited", NOW)).toBe(
      `Edited ${renderIn(DEFAULT_LOCALE, RECENT, RECENT_DETAIL_OPTS)}`,
    )
  })

  it("prefixes an older datetime with year", () => {
    expect(fmtLabeledDateTime(OLD.getTime(), "Archived", NOW)).toBe(
      `Archived ${renderIn(DEFAULT_LOCALE, OLD, OLDER_DETAIL_OPTS)}`,
    )
  })

  it("omits the prefix when the label is blank", () => {
    expect(fmtLabeledDateTime(RECENT.getTime(), "", NOW)).toBe(
      renderIn(DEFAULT_LOCALE, RECENT, RECENT_DETAIL_OPTS),
    )
  })

  it("renders against the locale it is given, not the host's", () => {
    expect(fmtLabeledDateTime(RECENT.getTime(), "Edited", NOW, "th")).toBe(
      `Edited ${renderIn("th", RECENT, RECENT_DETAIL_OPTS)}`,
    )
  })
})

describe("fmtDeadlineDate", () => {
  it("omits the year when the deadline is in the current calendar year", () => {
    expect(fmtDeadlineDate("2026-06-02", NOW)).toBe("June 2")
  })

  it("includes the year when the deadline is in a later calendar year", () => {
    expect(fmtDeadlineDate("2027-06-02", NOW)).toBe("June 2, 2027")
  })

  it("includes the year when the deadline is in a previous calendar year", () => {
    expect(fmtDeadlineDate("2025-06-02", NOW)).toBe("June 2, 2025")
  })

  it("parses YYYY-MM-DD as a local calendar date", () => {
    expect(fmtDeadlineDate("2026-07-01", NOW)).toBe("July 1")
  })

  it("returns em dash for null", () => {
    expect(fmtDeadlineDate(null, NOW)).toBe("—")
  })
})

describe("fmtLabeledDeadlineDate", () => {
  it("always includes the year and omits the time", () => {
    expect(fmtLabeledDeadlineDate("2026-06-02", "Due")).toBe("Due June 2, 2026")
    expect(fmtLabeledDeadlineDate("2027-06-02", "Due")).toBe("Due June 2, 2027")
  })
})
