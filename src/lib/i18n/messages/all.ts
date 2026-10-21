/**
 * Every catalog at once, for the translation TOOLING and tests only (AQU-2090).
 *
 * The app never imports this module: it loads English with the bundle and any
 * other locale on demand through `./index.ts`, so a visitor downloads one
 * language, not all of them. The catalog scripts (`scripts/i18n-catalog.ts`,
 * `i18n-todo.ts`) and tests that check every locale read them all from here.
 * Adding a locale means adding its module here, a loader in `./index.ts`, and a
 * `LOCALES` entry in `locales.ts` (a test keeps the first two in step).
 */

import { en, type Catalog } from "./en"
import { th } from "./th"
import { my } from "./my"
import { ms } from "./ms"
import { id } from "./id"
import { ar } from "./ar"
import { zh_Hans } from "./zh-Hans"
import { zh_Hant } from "./zh-Hant"
import { fr } from "./fr"
import { ru } from "./ru"
import { es } from "./es"
import { pt } from "./pt"

export const CATALOGS: Record<string, Catalog> = { en, th, my, ms, id, ar, "zh-Hans": zh_Hans, "zh-Hant": zh_Hant, ru, fr, es, pt }

/** Reject locale-only keys before publishing an invalid catalog. */
export function unknownCatalogKeys(catalogs: Record<string, Record<string, unknown>> = CATALOGS): string[] {
  const english = new Set(Object.keys(en))
  return Object.entries(catalogs).flatMap(([locale, catalog]) =>
    Object.keys(catalog).filter(key => !english.has(key)).map(key => `${locale}: ${key}`))
}
