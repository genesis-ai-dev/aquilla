/**
 * Translation coverage ratchet (AQU-2740).
 *
 * A key that a locale's catalog leaves out falls back to English (see
 * `translate.ts`). That keeps the UI working, but nothing ever forced a
 * translation in: catalogs only grew when someone ran a sweep, so every
 * feature PR that added English text shipped it in English in every other
 * locale. By 2026-11-19 Chinese was about 40% English.
 *
 * The ratchet has the same shape as `eslint-suppressions.json`. A committed
 * baseline (`translation-baseline.json`) lists, per key, the locales still
 * allowed to fall back. Every other key must be translated, and translated
 * against the current English, in every locale. The baseline only shrinks:
 * `i18n:import` prunes the entries it fills, and adding to it takes an
 * explicit `pnpm i18n:baseline --allow` that shows up in review.
 *
 * Two kinds of gap count:
 *   - **untranslated**: the locale has no value for the key.
 *   - **stale**: the locale has a value, but `source-hashes.json` says it was
 *     translated against English that has since changed. Rewording English is
 *     a change a translator has to see, same as adding it.
 *
 * Keys are checked whole, not per plural category. A plural key that has some
 * of a locale's categories still resolves through `selectPluralForm`'s
 * fallback, and `pnpm i18n:todo` keeps reporting the missing leaves.
 */

import { sourceHash, type SourceHashes } from "./catalog-export"
import { MESSAGE_KEYS } from "./context"
import { DEFAULT_LOCALE } from "./locales"
import type { Catalog, MessageKey } from "./messages/en"

/** Why a locale falls back for a key. */
export type GapKind = "untranslated" | "stale"

/** One locale's gaps: key → kind. */
export type LocaleGaps = Map<MessageKey, GapKind>

/**
 * The committed baseline: message key → the locales allowed to fall back for
 * it. Keyed by message key (not by locale) so a key added or removed is one
 * line of diff, and two branches that touch different keys merge cleanly.
 */
export type TranslationBaseline = Record<string, string[]>

/** A gap the baseline does not allow. */
export interface CoverageViolation {
  locale: string
  key: MessageKey
  kind: GapKind
}

/** Every key `locale` falls back on, and why. */
export function localeGaps(
  catalog: Catalog,
  hashes: SourceHashes,
  keys: readonly MessageKey[] = MESSAGE_KEYS,
  hashOf: (key: MessageKey) => string = sourceHash,
): LocaleGaps {
  const gaps: LocaleGaps = new Map()
  for (const key of keys) {
    if (catalog[key] === undefined) {
      gaps.set(key, "untranslated")
      continue
    }
    // A translation with no recorded hash predates the sidecar; there is
    // nothing to compare it against, so it is not reported stale (the same
    // rule `mergeCatalogs` and `i18n:todo` follow).
    const stored = hashes[key]
    if (stored !== undefined && stored !== hashOf(key)) gaps.set(key, "stale")
  }
  return gaps
}

/** Gaps for every non-English locale in `catalogs`. */
export function allLocaleGaps(
  catalogs: Record<string, Catalog>,
  hashes: Record<string, SourceHashes>,
  keys: readonly MessageKey[] = MESSAGE_KEYS,
  hashOf: (key: MessageKey) => string = sourceHash,
): Map<string, LocaleGaps> {
  const out = new Map<string, LocaleGaps>()
  for (const [locale, catalog] of Object.entries(catalogs)) {
    if (locale === DEFAULT_LOCALE) continue
    out.set(locale, localeGaps(catalog, hashes[locale] ?? {}, keys, hashOf))
  }
  return out
}

function allowed(baseline: TranslationBaseline, key: string, locale: string): boolean {
  return baseline[key]?.includes(locale) ?? false
}

/** Gaps the baseline does not cover: what a branch has to translate. */
export function coverageViolations(
  gaps: Map<string, LocaleGaps>,
  baseline: TranslationBaseline,
): CoverageViolation[] {
  const out: CoverageViolation[] = []
  for (const [locale, localeGap] of gaps) {
    for (const [key, kind] of localeGap) {
      if (!allowed(baseline, key, locale)) out.push({ locale, key, kind })
    }
  }
  return out
}

/**
 * Baseline entries that no longer stand for a gap: the locale has since been
 * translated, or the key is gone from English. Left in, they would let that
 * key slip back to English unnoticed, so the check fails on them too.
 */
export function unprunedEntries(
  gaps: Map<string, LocaleGaps>,
  baseline: TranslationBaseline,
): Array<{ key: string; locale: string }> {
  const out: Array<{ key: string; locale: string }> = []
  for (const [key, locales] of Object.entries(baseline)) {
    for (const locale of locales) {
      if (!gaps.get(locale)?.has(key as MessageKey)) out.push({ key, locale })
    }
  }
  return out
}

/** Sorted, de-duplicated copy, with empty entries dropped. */
export function normalizeBaseline(baseline: TranslationBaseline): TranslationBaseline {
  const out: TranslationBaseline = {}
  for (const key of Object.keys(baseline).sort()) {
    const locales = [...new Set(baseline[key])].sort()
    if (locales.length > 0) out[key] = locales
  }
  return out
}

/**
 * Drop every entry that is no longer a gap. Only ever removes: a gap the
 * baseline does not already list stays a violation.
 *
 * `onlyLocale` limits the prune to one locale, which is what `i18n:import`
 * wants: it knows that locale's new catalog, not the others'.
 */
export function pruneBaseline(
  baseline: TranslationBaseline,
  gaps: Map<string, LocaleGaps>,
  onlyLocale?: string,
): TranslationBaseline {
  const out: TranslationBaseline = {}
  for (const [key, locales] of Object.entries(baseline)) {
    out[key] = locales.filter(
      (locale) =>
        (onlyLocale !== undefined && locale !== onlyLocale) ||
        (gaps.get(locale)?.has(key as MessageKey) ?? false),
    )
  }
  return normalizeBaseline(out)
}

/** A baseline that allows exactly today's gaps: only for an explicit rebuild. */
export function baselineFromGaps(gaps: Map<string, LocaleGaps>): TranslationBaseline {
  const out: TranslationBaseline = {}
  for (const [locale, localeGap] of gaps) {
    for (const key of localeGap.keys()) (out[key] ??= []).push(locale)
  }
  return normalizeBaseline(out)
}

/**
 * Allow `keys` to fall back in the locales where they currently do: for a
 * string that should read the same in every language (a product name, a
 * format). The keys must exist; the result is shown in review like any
 * other edit to the baseline.
 */
export function allowInBaseline(
  baseline: TranslationBaseline,
  gaps: Map<string, LocaleGaps>,
  keys: readonly string[],
  locales?: readonly string[],
): TranslationBaseline {
  const out: TranslationBaseline = { ...baseline }
  for (const key of keys) {
    for (const [locale, localeGap] of gaps) {
      if (locales && !locales.includes(locale)) continue
      if (localeGap.has(key as MessageKey)) out[key] = [...(out[key] ?? []), locale]
    }
  }
  return normalizeBaseline(out)
}

/**
 * Serialize with one key per line: a 10,000-key file stays reviewable, and
 * branches that touch different keys do not conflict.
 */
export function renderBaseline(baseline: TranslationBaseline): string {
  const normalized = normalizeBaseline(baseline)
  const lines = Object.entries(normalized).map(
    ([key, locales]) => `  ${JSON.stringify(key)}: ${JSON.stringify(locales)}`,
  )
  return lines.length === 0 ? "{}\n" : `{\n${lines.join(",\n")}\n}\n`
}

/** Per-locale count of allowed gaps, for reports. */
export function baselineCounts(baseline: TranslationBaseline): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const locales of Object.values(baseline)) {
    for (const locale of locales) counts[locale] = (counts[locale] ?? 0) + 1
  }
  return counts
}
