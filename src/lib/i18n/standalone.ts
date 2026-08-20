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

import { CATALOGS } from "./messages"
import type { MessageKey } from "./messages/en"
import { DEFAULT_LOCALE, normalizeLocale } from "./locales"
import { readStoredLocale } from "./store"
import { translate, type TVars } from "./translate"

export function t(key: MessageKey, vars?: TVars): string {
  const locale = normalizeLocale(readStoredLocale())
  return translate(CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE], key, vars, locale)
}
