/**
 * i18n locale registry (AQU-511).
 *
 * The set of locales the UI can switch to, plus their writing direction. English
 * is the base/source locale; every other catalog falls back to it per key (see
 * `translate.ts`). Directions follow the ticket: only Arabic is RTL for now;
 * Thai/Burmese/Malay/Chinese render LTR. Add a locale here + a catalog in
 * `messages/index.ts` to make it selectable.
 *
 * A locale's `code` and `nativeName` are load-bearing claims, not decoration:
 * the code lands in `<html lang>` (font selection, screen-reader voice) and the
 * endonym is the only thing a speaker sees in the switcher. Registering a code
 * whose catalog is a different language than the code names is therefore a bug,
 * and a worse one than having no entry at all — see `LOCALE_ALIASES` (AQU-1306).
 *
 * Indonesian (`id`, AQU-869) and Malay (`ms`) are listed separately and their
 * catalogs are translated separately. They are close relatives, which is exactly
 * why the temptation to derive one from the other has to be named and refused:
 * the UI register is where they diverge most (`unggah`/`muat naik`,
 * `pratinjau`/`pratonton`, `hapus`/`padam`, `berkas`/`fail`, `mengunduh`/`memuat
 * turun`), so a Malay-derived `id` catalog would read as Malay to an Indonesian
 * speaker and repeat AQU-1306 under a new code.
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
  { code: "ms", englishName: "Malay", nativeName: "Bahasa Melayu", dir: "ltr" },
  { code: "id", englishName: "Indonesian", nativeName: "Bahasa Indonesia", dir: "ltr" },
  { code: "ar", englishName: "Arabic", nativeName: "العربية", dir: "rtl" },
  { code: "zh-Hans", englishName: "Simplified Chinese", nativeName: "简体中文", dir: "ltr" },
  { code: "zh-Hant", englishName: "Traditional Chinese", nativeName: "繁體中文", dir: "ltr" },
] as const

export const DEFAULT_LOCALE = "en"

/**
 * Retired locale codes → the code that now serves their content (AQU-1306).
 *
 * `mfa` (Patani Malay) was offered as "Bahasa Melayu Patani" from AQU-511 until
 * AQU-1306, but its catalog was standard Malay throughout — machine-translated
 * into formal Malaysian technical register, never into Patani (the audit and
 * evidence are in `messages/ms.ts`). The strings were fine; the label lied. So
 * the catalog moved to its true code `ms` / "Bahasa Melayu" and `mfa` maps here.
 *
 * The alias exists so the people who reported this keep a working UI: without
 * it, every stored `mfa` preference would fail `isSupportedLocale` and drop to
 * English, which reads as the app losing their language rather than correcting
 * its name. It resolves to the SAME strings they already had — only now honestly
 * labelled.
 *
 * Aliases are intentionally NOT in `LOCALES`, so an alias is reachable by a
 * stored preference or an `Accept-Language` header but never offered in the
 * switcher. Drop the `mfa` entry when a genuine Pattani Malay catalog — authored
 * and signed off by Pattani Malay speakers, not machine-derived from `ms` — is
 * registered under `mfa` again.
 *
 * `in` is Indonesian's pre-1989 ISO 639-1 code (AQU-869). It was never offered
 * by this app, but the JVM and older Android builds still emit it, so it can
 * arrive in a stored preference or an `Accept-Language` header. Without the
 * alias the primary-subtag branch would not save it — `in` shares no subtag with
 * `id` — and an Indonesian speaker would silently land on English.
 */
export const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  mfa: "ms",
  in: "id",
}

export function isSupportedLocale(code: string): boolean {
  return LOCALES.some((l) => l.code === code)
}

export function directionFor(code: string): Direction {
  return LOCALES.find((l) => l.code === code)?.dir ?? "ltr"
}

/**
 * Coerce an arbitrary code to a supported locale: exact match wins, then a
 * retired-code alias (`mfa` → `ms`), then a match on the primary subtag
 * (`en-US` → `en`), otherwise the default. Never throws.
 *
 * Aliases are checked before the primary-subtag fallback because they are exact
 * statements about one code, where the subtag branch is a guess.
 */
export function normalizeLocale(code: string | null | undefined): string {
  if (!code) return DEFAULT_LOCALE
  if (isSupportedLocale(code)) return code
  const alias = LOCALE_ALIASES[code] ?? LOCALE_ALIASES[code.toLowerCase()]
  if (alias && isSupportedLocale(alias)) return alias
  const primary = code.split("-")[0].toLowerCase()
  const match = LOCALES.find((l) => l.code.split("-")[0].toLowerCase() === primary)
  return match?.code ?? DEFAULT_LOCALE
}
