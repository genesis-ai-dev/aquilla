/**
 * i18n locale registry (AQU-511).
 *
 * The set of locales the UI can switch to, plus their writing direction. English
 * is the base/source locale; every other catalog falls back to it per key (see
 * `translate.ts`). Directions follow the ticket: only Arabic is RTL for now;
 * Thai/Burmese/Patani-Malay/Chinese render LTR. Add a locale here + a catalog in
 * `messages/index.ts` to make it selectable.
 *
 * Chinese ships as two script-subtag locales: `zh-Hans` (AQU-978) and `zh-Hant`
 * (AQU-976). `normalizeLocale()` prefers an exact match, so each script gets its
 * own catalog (`zh-TW`/`zh-CN` region codes are not exact matches — they fall
 * through with bare `zh` to the primary-subtag branch, which resolves to
 * whichever `zh-*` entry is listed FIRST). Keep `zh-Hans` first: the script the
 * larger population reads and the one the partner asked for.
 */

export type Direction = "ltr" | "rtl"

export interface LocaleMeta {
  /** BCP-47-ish code used as the storage value and `<html lang>`. */
  code: string
  /** Name in English, for admin/debug listings. */
  englishName: string
  /** Endonym, for the language switcher (shown to speakers of that language). */
  nativeName: string
  /** Writing direction; drives `<html dir>` and layout mirroring. */
  dir: Direction
}

export const LOCALES: readonly LocaleMeta[] = [
  { code: "en", englishName: "English", nativeName: "English", dir: "ltr" },
  { code: "th", englishName: "Thai", nativeName: "ไทย", dir: "ltr" },
  { code: "my", englishName: "Burmese", nativeName: "မြန်မာ", dir: "ltr" },
  { code: "mfa", englishName: "Patani Malay", nativeName: "Bahasa Melayu Patani", dir: "ltr" },
  { code: "ar", englishName: "Arabic", nativeName: "العربية", dir: "rtl" },
  { code: "zh-Hans", englishName: "Simplified Chinese", nativeName: "简体中文", dir: "ltr" },
  { code: "zh-Hant", englishName: "Traditional Chinese", nativeName: "繁體中文", dir: "ltr" },
] as const

export const DEFAULT_LOCALE = "en"

export function isSupportedLocale(code: string): boolean {
  return LOCALES.some((l) => l.code === code)
}

export function directionFor(code: string): Direction {
  return LOCALES.find((l) => l.code === code)?.dir ?? "ltr"
}

/**
 * Coerce an arbitrary code to a supported locale: exact match wins, then a match
 * on the primary subtag (`en-US` → `en`), otherwise the default. Never throws.
 */
export function normalizeLocale(code: string | null | undefined): string {
  if (!code) return DEFAULT_LOCALE
  if (isSupportedLocale(code)) return code
  const primary = code.split("-")[0].toLowerCase()
  const match = LOCALES.find((l) => l.code.split("-")[0].toLowerCase() === primary)
  return match?.code ?? DEFAULT_LOCALE
}
