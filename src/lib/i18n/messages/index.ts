/**
 * Catalog registry (AQU-511, restructured in AQU-832, loaded on demand since
 * AQU-2090).
 *
 * English ships with the app: it is the source of every key and the per-key
 * fallback, so the UI is complete before anything else arrives. Every other
 * locale is its own chunk, fetched the first time something asks for it: the
 * app downloads the visitor's language, not all of them (the nine catalogs were
 * 4.5 MB of every first load).
 *
 * Non-English catalogs fall back to English key-by-key until a translator fills
 * them in, so a partial catalog is safe to ship. Each locale lives in its own
 * module so it can be *generated* (`scripts/i18n-catalog.ts import`, AQU-832).
 * Adding a locale means adding its module, a loader below, an import in
 * `./all.ts` (the tooling's every-catalog view), and a `LOCALES` entry in
 * `locales.ts`.
 */

import { en, type Catalog } from "./en"

const LOADERS: Record<string, () => Promise<Catalog>> = {
  th: () => import("./th").then((m) => m.th),
  my: () => import("./my").then((m) => m.my),
  ms: () => import("./ms").then((m) => m.ms),
  id: () => import("./id").then((m) => m.id),
  ar: () => import("./ar").then((m) => m.ar),
  "zh-Hans": () => import("./zh-Hans").then((m) => m.zh_Hans),
  "zh-Hant": () => import("./zh-Hant").then((m) => m.zh_Hant),
  ru: () => import("./ru").then((m) => m.ru),
  fr: () => import("./fr").then((m) => m.fr),
  es: () => import("./es").then((m) => m.es),
  pt: () => import("./pt").then((m) => m.pt),
}

/** Every locale that has a catalog, English first. */
export const CATALOG_LOCALES: readonly string[] = ["en", ...Object.keys(LOADERS)]

const loaded = new Map<string, Catalog>([["en", en]])
/** Tests only: every catalog, read on each lookup (see `answerFromCatalogsForTests`). */
let testSource: Record<string, Catalog> | null = null
const pending = new Map<string, Promise<Catalog | undefined>>()
const listeners = new Set<() => void>()

/** `locale`'s catalog if it has arrived (English always has), else undefined. */
export function catalogFor(locale: string): Catalog | undefined {
  return loaded.get(locale) ?? testSource?.[locale]
}

/**
 * Fetch `locale`'s catalog, once. Resolves to undefined for a locale with no
 * catalog of its own (it renders in English). A failed fetch is not cached, so
 * a later call tries again.
 */
export function loadCatalog(locale: string): Promise<Catalog | undefined> {
  const have = catalogFor(locale)
  if (have) return Promise.resolve(have)
  const load = LOADERS[locale]
  if (!load) return Promise.resolve(undefined)
  let inFlight = pending.get(locale)
  if (!inFlight) {
    inFlight = load().then(
      (catalog) => {
        loaded.set(locale, catalog)
        pending.delete(locale)
        for (const listener of listeners) listener()
        return catalog
      },
      (error: unknown) => {
        pending.delete(locale)
        throw error
      },
    )
    pending.set(locale, inFlight)
  }
  return inFlight
}

/**
 * Put `catalog` in place for `locale` as if it had been fetched, and re-render
 * whoever is listening. For the catalog round-trip tests, which ship a freshly
 * translated catalog into the registry the provider reads.
 */
export function registerCatalog(locale: string, catalog: Catalog): void {
  loaded.set(locale, catalog)
  for (const listener of listeners) listener()
}

/**
 * Tests only: answer every lookup from `source` (looked up on each call, so a
 * test that swaps a locale's catalog in `messages/all.ts` is seen at once), as
 * if every catalog had already arrived. `src/test-setup.ts` installs it so
 * components render in any locale synchronously, as before AQU-2090; pass null
 * to test the real on-demand loading.
 */
export function answerFromCatalogsForTests(source: Record<string, Catalog> | null): void {
  testSource = source
}

/** Every catalog, for the rare screen that matches text across languages. */
export async function loadAllCatalogs(): Promise<Record<string, Catalog>> {
  await Promise.all(CATALOG_LOCALES.map((locale) => loadCatalog(locale).catch(() => undefined)))
  return Object.fromEntries(CATALOG_LOCALES.flatMap((locale) => {
    const catalog = catalogFor(locale)
    return catalog ? [[locale, catalog]] : []
  }))
}

/** Called whenever another catalog arrives; returns the unsubscribe. */
export function onCatalogLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
