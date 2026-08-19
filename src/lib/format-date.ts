import { formatDate, formatDateTime } from "./i18n/format"
import { DEFAULT_LOCALE } from "./i18n/locales"

const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})/

function parseTimestamp(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const t = typeof value === "number" ? value : Date.parse(value)
  return Number.isNaN(t) ? null : t
}

/**
 * Deadlines are calendar dates (`YYYY-MM-DD`), not instants. `Date.parse` of a
 * date-only ISO string is UTC midnight, which shifts the day backward in US
 * timezones — parse as a local calendar date instead.
 */
function parseDeadlineValue(value: number | string | Date | null | undefined): number | null {
  if (value == null) return null
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isNaN(t) ? null : t
  }
  if (typeof value === "number") return Number.isNaN(value) ? null : value
  const m = DATE_ONLY_RE.exec(value)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return parseTimestamp(value)
}

function isDifferentCalendarYear(t: number, now: number): boolean {
  return new Date(t).getFullYear() !== new Date(now).getFullYear()
}

function isOlderThanOneYear(t: number, now: number): boolean {
  return now - t > YEAR_MS
}

/**
 * Compact calendar label — "July 3" within the last year, else "Aug 2024".
 *
 * Locale-aware (WS-09): renders against `locale` (defaulting to the base `en`
 * catalog locale, not the browser's) instead of the bare `toLocaleDateString`
 * this used to call directly.
 */
export function fmtShortCalendarDate(
  value: number | string | null | undefined,
  now: number = Date.now(),
  locale: string = DEFAULT_LOCALE,
): string {
  const t = parseTimestamp(value)
  if (t == null) return "—"
  const d = new Date(t)
  if (isOlderThanOneYear(t, now)) {
    return formatDate(d, locale, { month: "short", year: "numeric" })
  }
  return formatDate(d, locale, { month: "long", day: "numeric" })
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

/**
 * Tooltip detail, e.g. "Edited July 3, 1:37:08 p.m." or "Edited Aug 18, 2024,
 * 7:41:07 p.m.". Locale-aware (WS-09) — see `fmtShortCalendarDate`.
 */
export function fmtLabeledDateTime(
  value: number | string,
  label: string,
  now: number = Date.now(),
  locale: string = DEFAULT_LOCALE,
): string {
  const t = parseTimestamp(value)
  if (t == null) return label
  const d = new Date(t)
  const opts = isOlderThanOneYear(t, now) ? OLDER_DETAIL_OPTS : RECENT_DETAIL_OPTS
  const when = formatDateTime(d, locale, opts)
  const prefix = label.trim()
  return prefix ? `${prefix} ${when}` : when
}

const DEADLINE_SAME_YEAR_OPTS: Intl.DateTimeFormatOptions = {
  month: "long",
  day: "numeric",
}

const DEADLINE_OTHER_YEAR_OPTS: Intl.DateTimeFormatOptions = {
  month: "long",
  day: "numeric",
  year: "numeric",
}

/**
 * Visible deadline label — "June 2" in the current calendar year, else
 * "June 2, 2027". Unlike `fmtShortCalendarDate`, a next-year date always
 * includes the year (deadlines are often set 6–18 months out).
 */
export function fmtDeadlineDate(
  value: number | string | Date | null | undefined,
  now: number = Date.now(),
  locale: string = DEFAULT_LOCALE,
): string {
  const t = parseDeadlineValue(value)
  if (t == null) return "—"
  const d = new Date(t)
  const opts = isDifferentCalendarYear(t, now) ? DEADLINE_OTHER_YEAR_OPTS : DEADLINE_SAME_YEAR_OPTS
  return formatDate(d, locale, opts)
}

/**
 * Deadline hover detail — always includes the year, never a time
 * ("Due June 2, 2027"). Deadlines are date-only.
 */
export function fmtLabeledDeadlineDate(
  value: number | string | Date | null | undefined,
  label: string,
  locale: string = DEFAULT_LOCALE,
): string {
  const t = parseDeadlineValue(value)
  if (t == null) return label
  const when = formatDate(new Date(t), locale, DEADLINE_OTHER_YEAR_OPTS)
  const prefix = label.trim()
  return prefix ? `${prefix} ${when}` : when
}
