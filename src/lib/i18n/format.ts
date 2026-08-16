/**
 * Locale-aware formatting (AQU-511 follow-on, WS-09).
 *
 * `toLocaleDateString()` / `toLocaleString()` with no locale argument format
 * against the *browser's* language, not the app's active i18n locale — so a
 * user who switches Aquilla to Arabic still sees en-US dates and digits next
 * to Arabic UI text. Every formatter here takes (or, via `useFormat()`,
 * closes over) the app's active locale instead.
 *
 * Two call shapes, because callers exist both ways:
 *   - Inside React: `useFormat()` reads the active locale from `I18nProvider`
 *     and returns bound formatter functions — no locale threading.
 *   - Plain modules (parsers, pure helpers, tests): the explicit-locale
 *     functions (`formatDate`, `formatNumber`, …) take `locale` as an
 *     argument, defaulting to `DEFAULT_LOCALE` so existing untranslated call
 *     sites keep compiling if a locale genuinely isn't available.
 *
 * Bidi isolation: `bidiIsolate` wraps a numeric/Latin token in Unicode
 * FSI/PDI isolate characters (U+2068/U+2069) so it doesn't reorder inside
 * RTL prose under the bidi algorithm — e.g. a `2/4` ratio or `12%` embedded
 * in an Arabic sentence. This is the same technique `nav.sidebarSection`
 * already documents for its setup-progress chip; this module makes it a
 * shared helper instead of a pattern every caller reinvents.
 */

import { useMemo } from "react"
import { useI18n } from "./I18nProvider"
import { DEFAULT_LOCALE } from "./locales"

// ---------------------------------------------------------------------------
// Bidi isolation
// ---------------------------------------------------------------------------

/** Unicode "First Strong Isolate" — opens an isolated bidi run. */
export const BIDI_FSI = "⁨"
/** Unicode "Pop Directional Isolate" — closes the isolated bidi run. */
export const BIDI_PDI = "⁩"

/**
 * Wrap a formatted number, ratio, or other Latin/neutral token in FSI/PDI
 * isolates so embedding it inside RTL text doesn't let the bidi algorithm
 * reorder it. Apply this at the call site, around the *whole* token
 * (`"2/4"`, `"12%"`, `"40.0 MB"`) — not around the sentence it sits in.
 */
export function bidiIsolate(value: string | number): string {
  return `${BIDI_FSI}${value}${BIDI_PDI}`
}

// ---------------------------------------------------------------------------
// Dates & times
// ---------------------------------------------------------------------------

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function formatDate(
  value: Date | number | string,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options ?? { dateStyle: "medium" }).format(toDate(value))
}

export function formatTime(
  value: Date | number | string,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options ?? { timeStyle: "short" }).format(toDate(value))
}

export function formatDateTime(
  value: Date | number | string,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(
    locale,
    options ?? { dateStyle: "medium", timeStyle: "short" },
  ).format(toDate(value))
}

const RELATIVE_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "seconds" },
  { amount: 60, unit: "minutes" },
  { amount: 24, unit: "hours" },
  { amount: 7, unit: "days" },
  { amount: 4.34524, unit: "weeks" },
  { amount: 12, unit: "months" },
  { amount: Number.POSITIVE_INFINITY, unit: "years" },
]

/** "3 days ago" / "in 2 hours", grammatically correct for `locale`. */
export function formatRelativeTime(
  value: Date | number | string,
  locale: string = DEFAULT_LOCALE,
  now: number = Date.now(),
): string {
  let duration = (toDate(value).getTime() - now) / 1000
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  for (const division of RELATIVE_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return rtf.format(Math.round(duration), "years")
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function formatNumber(
  value: number,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

/**
 * Format a count for interpolation into a plural-governed `t()` message
 * (`t("x.y", { count: formatCount(n, locale) })`). Grouping is localized like
 * `formatNumber`, but digits are always forced to ASCII (`numberingSystem:
 * "latn"`): `pluralCountFrom` (`i18n/plurals.ts`) recovers the selection
 * magnitude from an already-formatted count by stripping non-`[0-9]`
 * characters, and only matches ASCII digits. A locale whose default
 * numbering system renders native digits (e.g. some Arabic dialects use
 * Eastern Arabic numerals) would otherwise strip to an empty string and
 * silently fall back to the `other` plural category.
 */
export function formatCount(value: number, locale: string = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { numberingSystem: "latn" }).format(value)
}

/** `value` is a 0–1 fraction; renders as a localized percentage ("31%"). */
export function formatPercent(
  value: number,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0, ...options }).format(value)
}

// ---------------------------------------------------------------------------
// Byte sizes
// ---------------------------------------------------------------------------

const BYTES_PER_MB = 1024 * 1024

/**
 * Format a byte count as a one-decimal megabyte string, e.g. `"40.0 MB"`.
 *
 * `MB` is left untranslated on purpose: it's an SI-derived unit symbol, not a
 * word — ISO 80000 unit symbols are language-invariant the same way `km` or
 * `kg` are, and every shipped locale (Thai, Burmese, Patani Malay, Arabic)
 * keeps Latin unit symbols in ordinary prose. What *was* locale-blind is the
 * number in front of it (decimal separator, digit shape), which now goes
 * through `Intl.NumberFormat`. Callers embedding the result inside translated
 * RTL text should wrap it with `bidiIsolate` at the call site.
 */
export function formatMB(bytes: number, locale: string = DEFAULT_LOCALE): string {
  const mb = Math.max(0, bytes) / BYTES_PER_MB
  return `${formatNumber(mb, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
}

/**
 * Human-readable byte-transfer progress.
 *
 * - total known (> 0):  `"12.4 / 40.0 MB (31%)"` — transferred, total, percent.
 * - total unknown/0:    `"12.4 MB"` — transferred-so-far only, never a
 *   fabricated/misleading total.
 */
export function formatBytesProgress(
  received: number | undefined,
  total: number | undefined,
  locale: string = DEFAULT_LOCALE,
): string {
  const rcv = Math.max(0, received ?? 0)
  if (!total || total <= 0) return formatMB(rcv, locale)
  const pct = formatPercent(rcv / total, locale)
  return `${formatMB(rcv, locale).replace(" MB", "")} / ${formatMB(total, locale)} (${pct})`
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Join `items` the way a sentence in `locale` would, instead of a bare
 * `.join(", ")`. Defaults to `type: "unit"` — comma-separated with no
 * conjunction, the locale-aware equivalent of `.join(", ")` — since most
 * existing call sites are enumerations ("Saved: name, source language.") not
 * natural-language lists. Pass `type: "conjunction"` for "A, B, and C" /
 * `"disjunction"` for "A, B, or C".
 */
export function formatList(
  items: readonly string[],
  locale: string = DEFAULT_LOCALE,
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(locale, { type: "unit", style: "long", ...options }).format(items)
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface LocaleFormatters {
  locale: string
  date: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string
  time: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string
  dateTime: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string
  relativeTime: (value: Date | number | string, now?: number) => string
  number: (value: number, options?: Intl.NumberFormatOptions) => string
  count: (value: number) => string
  percent: (value: number, options?: Intl.NumberFormatOptions) => string
  bytes: (bytes: number) => string
  bytesProgress: (received: number | undefined, total: number | undefined) => string
  list: (items: readonly string[], options?: Intl.ListFormatOptions) => string
  isolate: (value: string | number) => string
}

/** Formatters bound to the active app locale (`I18nProvider`). */
export function useFormat(): LocaleFormatters {
  const { locale } = useI18n()
  return useMemo<LocaleFormatters>(
    () => ({
      locale,
      date: (value, options) => formatDate(value, locale, options),
      time: (value, options) => formatTime(value, locale, options),
      dateTime: (value, options) => formatDateTime(value, locale, options),
      relativeTime: (value, now) => formatRelativeTime(value, locale, now),
      number: (value, options) => formatNumber(value, locale, options),
      count: (value) => formatCount(value, locale),
      percent: (value, options) => formatPercent(value, locale, options),
      bytes: (bytes) => formatMB(bytes, locale),
      bytesProgress: (received, total) => formatBytesProgress(received, total, locale),
      list: (items, options) => formatList(items, locale, options),
      isolate: bidiIsolate,
    }),
    [locale],
  )
}
