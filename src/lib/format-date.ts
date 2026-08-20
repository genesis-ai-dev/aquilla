import { formatDate, formatDateTime } from "./i18n/format"
import { DEFAULT_LOCALE } from "./i18n/locales"

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

function parseTimestamp(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const t = typeof value === "number" ? value : Date.parse(value)
  return Number.isNaN(t) ? null : t
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
  return `${label} ${when}`
}
