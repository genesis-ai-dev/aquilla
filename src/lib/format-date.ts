const YEAR_MS = 365 * 24 * 60 * 60 * 1000

function parseTimestamp(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const t = typeof value === "number" ? value : Date.parse(value)
  return Number.isNaN(t) ? null : t
}

function isOlderThanOneYear(t: number, now: number): boolean {
  return now - t > YEAR_MS
}

/** Compact calendar label — "July 3" within the last year, else "Aug 2024". */
export function fmtShortCalendarDate(
  value: number | string | null | undefined,
  now: number = Date.now(),
): string {
  const t = parseTimestamp(value)
  if (t == null) return "—"
  const d = new Date(t)
  if (isOlderThanOneYear(t, now)) {
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" })
  }
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" })
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

/** Tooltip detail, e.g. "Edited July 3, 1:37:08 p.m." or "Edited Aug 18, 2024, 7:41:07 p.m." */
export function fmtLabeledDateTime(
  value: number | string,
  label: string,
  now: number = Date.now(),
): string {
  const t = parseTimestamp(value)
  if (t == null) return label
  const d = new Date(t)
  const opts = isOlderThanOneYear(t, now) ? OLDER_DETAIL_OPTS : RECENT_DETAIL_OPTS
  const when = d.toLocaleString(undefined, opts)
  return `${label} ${when}`
}
