/**
 * Locale persistence + initial-locale detection (AQU-511).
 *
 * Pure, window-guarded helpers so the provider stays thin and the selection
 * logic is unit-testable. Preference order for the initial locale: a previously
 * chosen (and still-supported) locale, else the browser's language normalized to
 * a supported one, else English.
 */

import { isSupportedLocale, LOCALE_ALIASES, normalizeLocale } from "./locales"

export const LOCALE_STORAGE_KEY = "aquilla-locale"

interface LocaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Read through globalThis rather than the `window` global, so this module
 *  also type-checks in the sync-worker (no DOM lib), which bundles the import
 *  normalizer that reaches it (the Drive folder sync). */
function localeStorage(): LocaleStorage | null {
  return (globalThis as { window?: { localStorage: LocaleStorage } }).window?.localStorage ?? null
}

export function readStoredLocale(): string | null {
  return localeStorage()?.getItem(LOCALE_STORAGE_KEY) ?? null
}

export function writeStoredLocale(code: string): void {
  localeStorage()?.setItem(LOCALE_STORAGE_KEY, code)
}

/**
 * A stored preference wins over the navigator, but only when it names a locale
 * we can honour: an exact registry code, or a retired code with an explicit
 * alias (`mfa` → `ms`, AQU-1306). A stored code that resolves only by the
 * primary-subtag *guess* in `normalizeLocale` does not qualify — garbage in
 * storage should not outrank a real `navigator.language`, which is why
 * `isSupportedLocale` is checked here rather than normalizing unconditionally.
 */
export function detectInitialLocale(stored: string | null, navigatorLang: string | null): string {
  if (stored && (isSupportedLocale(stored) || stored in LOCALE_ALIASES)) {
    return normalizeLocale(stored)
  }
  return normalizeLocale(navigatorLang)
}
