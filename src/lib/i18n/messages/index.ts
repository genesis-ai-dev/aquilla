/**
 * Catalog registry (AQU-511, restructured in AQU-832).
 *
 * Non-English catalogs start empty and fall back to English key-by-key until a
 * translator fills them in — that keeps the app fully functional (no raw keys)
 * while localization lands incrementally.
 *
 * Each locale now lives in its own module so it can be *generated*: the AQU-832
 * loop translates the en catalog inside an Aquilla project and writes the result
 * back over `messages/<locale>.ts` (`scripts/i18n-catalog.ts import`). Adding a
 * locale means adding its module here and a `LOCALES` entry in `locales.ts`.
 */

import { en, type Catalog } from "./en"
import { th } from "./th"
import { my } from "./my"
import { mfa } from "./mfa"
import { ar } from "./ar"

export const CATALOGS: Record<string, Catalog> = { en, th, my, mfa, ar }
