/**
 * Catalog registry (AQU-511).
 *
 * Non-English catalogs start empty and fall back to English key-by-key until a
 * translator fills them in — that keeps the app fully functional (no raw keys)
 * while localization lands incrementally. Translating the core chrome for
 * Burmese (`my`) and Patani Malay (`mfa`) is the AQU-511 follow-up; drop the
 * translated strings into the matching object below as they arrive.
 */

import { en, type Catalog } from "./en"

const th: Catalog = {}
const my: Catalog = {}
const mfa: Catalog = {}
const ar: Catalog = {}

export const CATALOGS: Record<string, Catalog> = { en, th, my, mfa, ar }
