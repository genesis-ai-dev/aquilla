/**
 * `t()` for modules that run OUTSIDE React — plain fetch helpers and `src/lib`
 * code with no hooks available, whose thrown messages are rendered verbatim by
 * a component's `err.message` catch.
 *
 * It resolves the active locale straight from storage (the same source
 * `I18nProvider` seeds its initial state from) and falls back to English
 * exactly like the provider-less FALLBACK_CONTEXT in I18nProvider.tsx.
 *
 * Inside a component, use `useT()` instead — it re-renders on a locale change,
 * which this cannot do. See AQU-820/AQU-832.
 */

import { catalogFor } from "./messages"
import type { MessageKey } from "./messages/en"
import { DEFAULT_LOCALE, normalizeLocale } from "./locales"
import { readStoredLocale } from "./store"
import { translate, type TVars } from "./translate"

export function t(key: MessageKey, vars?: TVars): string {
  const locale = normalizeLocale(readStoredLocale())
  // English until the locale's catalog has arrived (main.tsx fetches it first).
  return translate(catalogFor(locale) ?? catalogFor(DEFAULT_LOCALE), key, vars, locale)
}

/**
 * `t()`, but `null` when the active locale's catalog has no entry for `key` —
 * i.e. exactly when `t()` would fall back to English (AQU-1821).
 *
 * The AQU-511 fallback is right for a whole sentence: English text beats a raw
 * key. It is wrong for a word that gets interpolated INTO a localized sentence,
 * because the result changes language mid-clause ("ဤteam အတွက်"). A caller that
 * can drop its clause entirely asks for the noun this way and omits the clause
 * when the answer is `null`, so a locale is either fully translated or silent —
 * never half-English. `locales.ts` (AQU-1306) rules out filling the gap with a
 * machine translation, so dropping the clause is the honest option.
 *
 * English itself is never `null`: `en` is the source of every key.
 */
export function tIfLocalized(key: MessageKey, vars?: TVars): string | null {
  const locale = normalizeLocale(readStoredLocale())
  if (locale === DEFAULT_LOCALE) return t(key, vars)
  const catalog = catalogFor(locale)
  // A catalog chunk that has not arrived yet is treated as untranslated: the
  // clause is dropped for this one render rather than flashing English.
  if (!catalog || catalog[key] === undefined) return null
  return translate(catalog, key, vars, locale)
}
