/**
 * Locale persistence + initial-locale detection (AQU-511).
 *
 * Pure, window-guarded helpers so the provider stays thin and the selection
 * logic is unit-testable. Preference order for the initial locale: a previously
 * chosen (and still-supported) locale, else the browser's language normalized to
 * a supported one, else English.
 */

import { isSupportedLocale, normalizeLocale } from "./locales"

export const LOCALE_STORAGE_KEY = "aquilla-locale"

export function readStoredLocale(): string | null {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(LOCALE_STORAGE_KEY)
}

export function writeStoredLocale(code: string): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(LOCALE_STORAGE_KEY, code)
}

export function detectInitialLocale(stored: string | null, navigatorLang: string | null): string {
  if (stored && isSupportedLocale(stored)) return stored
  return normalizeLocale(navigatorLang)
}
