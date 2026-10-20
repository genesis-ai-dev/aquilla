/**
 * I18nProvider + hooks (AQU-511).
 *
 * Holds the active locale, persists changes, exposes a type-safe `t(key, vars)`
 * that resolves count-governed keys through the active locale's plural rules,
 * and mirrors the locale onto `<html lang>` / `<html dir>` so RTL locales flip
 * layout direction. Behaviour is neutral for the default English/LTR locale, so
 * mounting the provider at the app root is a no-op until a locale is chosen.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { ReactNode } from "react"
import { catalogFor, loadCatalog, onCatalogLoaded } from "./messages"
import { en, type MessageKey } from "./messages/en"
import { translate, type TVars } from "./translate"
import {
  DEFAULT_LOCALE,
  directionFor,
  LOCALES,
  normalizeLocale,
  type Direction,
  type LocaleMeta,
} from "./locales"
import { detectInitialLocale, readStoredLocale, writeStoredLocale } from "./store"

export type TFunction = (key: MessageKey, vars?: TVars) => string

interface I18nContextValue {
  locale: string
  dir: Direction
  locales: readonly LocaleMeta[]
  setLocale: (code: string) => void
  t: TFunction
}

const I18nContext = createContext<I18nContextValue | null>(null)

function applyDocumentLocale(locale: string, dir: Direction): void {
  if (typeof document === "undefined") return
  const html = document.documentElement
  html.lang = locale
  html.dir = dir
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<string>(() =>
    detectInitialLocale(
      readStoredLocale(),
      typeof navigator !== "undefined" ? navigator.language : null,
    ),
  )

  const dir = directionFor(locale)

  // AQU-2090: only English ships with the app. Another locale's catalog is
  // fetched when it's first chosen (main.tsx fetches the starting one before
  // the first paint); until it arrives the UI reads English, then re-renders.
  const [, setCatalogsLoaded] = useState(0)
  useEffect(() => onCatalogLoaded(() => setCatalogsLoaded((n) => n + 1)), [])
  useEffect(() => {
    void loadCatalog(locale).catch(() => {
      // Offline or a failed fetch: stay in English; the next pick retries.
    })
  }, [locale])
  const catalog = catalogFor(locale) ?? en

  useEffect(() => {
    applyDocumentLocale(locale, dir)
  }, [locale, dir])

  const setLocale = useCallback((code: string) => {
    const next = normalizeLocale(code)
    setLocaleState(next)
    writeStoredLocale(next)
  }, [])

  const t = useCallback<TFunction>(
    // The locale is passed as well as the catalog: plural-category selection is
    // a property of the language, not of which strings happen to be translated.
    (key, vars) => translate(catalog, key, vars, locale),
    [catalog, locale],
  )

  const value = useMemo<I18nContextValue>(
    () => ({ locale, dir, locales: LOCALES, setLocale, t }),
    [locale, dir, setLocale, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * Provider-less fallback — a frozen, referentially stable English context.
 *
 * `t()` is about to be called from ~240 components, and the vast majority of
 * their existing test files do not mount a provider. Throwing there would force
 * wrapper churn across the whole suite to buy nothing: English is already the
 * documented per-key fallback, so resolving against the `en` catalog is the same
 * answer the provider would give for an unset locale.
 *
 * `setLocale` is a no-op because with no provider there is no state to change
 * and nothing to persist; chrome that needs to know whether switching is even
 * possible should use `useI18nOptional()` instead of inspecting this.
 */
const FALLBACK_CONTEXT: I18nContextValue = Object.freeze<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  dir: directionFor(DEFAULT_LOCALE),
  locales: LOCALES,
  setLocale: () => {},
  t: (key, vars) => translate(en, key, vars, DEFAULT_LOCALE),
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK_CONTEXT
}

/**
 * Optional read for chrome that may render outside I18nProvider — mirrors the
 * BrandContext optional-read pattern in AppShell. Returns null instead of
 * throwing so widely-shared chrome (AppShell) can skip locale-dependent
 * controls in call sites/tests that don't mount the provider, rather than
 * requiring every one of them to add it.
 */
export function useI18nOptional(): I18nContextValue | null {
  return useContext(I18nContext)
}

/** Convenience hook for components that only need the translate function. */
export function useT(): TFunction {
  return useI18n().t
}
