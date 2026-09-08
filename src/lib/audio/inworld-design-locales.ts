// Language + accent for Inworld Voice Design (freeform and structured).
//
// Inworld takes a single `languageCode` (`en-US`, `en-scottish`, `kbt`). The
// Portal splits GET /voices/v1/supportedLanguages into Language (family) and
// Accent (accentDisplayName). We persist the row's `code`.
// https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/design-voice

import { toInworldLanguage } from "./inworld-languages"
import { INWORLD_TTS2_LANGUAGE_NAMES } from "./inworld-tts2-languages"
import type { InworldSupportedLanguage } from "./inworld-supported-languages"

export const INWORLD_DESIGN_DEFAULT_LOCALE = "en-US"

export function primaryLanguageOf(locale: string): string {
  const mapped = toInworldLanguage(locale) ?? locale.trim()
  return mapped.split("-")[0]?.toLowerCase() ?? ""
}

export function regionOf(locale: string): string | undefined {
  const mapped = toInworldLanguage(locale) ?? locale.trim()
  const region = mapped.split("-")[1]
  return region ? region.toUpperCase() : undefined
}

/** Regional-indicator flag for a ISO 3166-1 alpha-2 region (US → 🇺🇸). */
export function regionFlagEmoji(region: string | undefined): string {
  if (!region || !/^[A-Za-z]{2}$/.test(region)) return ""
  const upper = region.toUpperCase()
  return String.fromCodePoint(
    ...[...upper].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65),
  )
}

function foldLabel(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase()
}

export function rowForDesignCode(
  code: string | undefined,
  rows: readonly InworldSupportedLanguage[],
): InworldSupportedLanguage | undefined {
  const needle = code?.trim().toLowerCase()
  if (!needle) return undefined
  return rows.find((row) => row.code.toLowerCase() === needle)
}

export function withExtraDesignLanguage(
  rows: readonly InworldSupportedLanguage[],
  extra?: string,
): InworldSupportedLanguage[] {
  const mapped = toInworldLanguage(extra) ?? extra?.trim()
  if (!mapped) return [...rows]
  if (rows.some((row) => row.code.toLowerCase() === mapped.toLowerCase())) return [...rows]
  const familyCode = mapped.split("-")[0] || mapped
  const family = rows.find((row) => row.familyCode.toLowerCase() === familyCode.toLowerCase())
  return [
    ...rows,
    {
      code: mapped,
      familyCode: family?.familyCode ?? familyCode,
      familyDisplayName: family?.familyDisplayName ?? familyCode,
      accentDisplayName: "",
      displayName: family?.familyDisplayName ?? mapped,
      creationEnabled: true,
      hasVoices: false,
    },
  ]
}

export function designLanguageFamilies(
  rows: readonly InworldSupportedLanguage[],
): Array<{ familyCode: string; familyDisplayName: string }> {
  const out: Array<{ familyCode: string; familyDisplayName: string }> = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.familyCode.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ familyCode: row.familyCode, familyDisplayName: row.familyDisplayName })
  }
  return out
}

export function designAccentsForFamily(
  familyCode: string,
  rows: readonly InworldSupportedLanguage[],
): InworldSupportedLanguage[] {
  const key = familyCode.trim().toLowerCase()
  if (!key) return []
  const inFamily = rows.filter((row) => row.familyCode.toLowerCase() === key)
  const named = inFamily.filter((row) => row.accentDisplayName)
  return named.length > 0 ? named : inFamily
}

export function defaultCodeForFamily(
  familyCode: string,
  rows: readonly InworldSupportedLanguage[],
): string {
  const accents = designAccentsForFamily(familyCode, rows)
  if (accents.length === 0) return INWORLD_DESIGN_DEFAULT_LOCALE
  const us = accents.find((row) => regionOf(row.code) === "US")
  if (us) return us.code
  const family = familyCode.trim().toLowerCase()
  const native = accents.find((row) => {
    const region = regionOf(row.code)
    return Boolean(region && region.toLowerCase() === family)
  })
  if (native) return native.code
  const voiced = accents.find((row) => row.hasVoices)
  if (voiced) return voiced.code
  return accents[0]?.code ?? INWORLD_DESIGN_DEFAULT_LOCALE
}

function familyMatchingLabel(
  value: string,
  rows: readonly InworldSupportedLanguage[],
): string | undefined {
  const folded = foldLabel(value)
  if (!folded) return undefined
  const hit = rows.find((row) => (
    foldLabel(row.familyDisplayName) === folded
    || foldLabel(row.displayName) === folded
    || foldLabel(row.familyCode) === folded
  ))
  return hit?.familyCode
}

/** Map a saved or lane tag onto a `languageCode` from the catalog. */
export function canonicalizeDesignLocale(
  value: string | undefined,
  rows: readonly InworldSupportedLanguage[],
): string {
  const exact = rowForDesignCode(value, rows) ?? rowForDesignCode(toInworldLanguage(value), rows)
  if (exact) {
    const accents = designAccentsForFamily(exact.familyCode, rows)
    if (accents.some((row) => row.code.toLowerCase() === exact.code.toLowerCase())) {
      return exact.code
    }
    return defaultCodeForFamily(exact.familyCode, rows)
  }
  const mapped = toInworldLanguage(value)
  const mappedFamily = mapped
    ? rows.find((row) => row.familyCode.toLowerCase() === primaryLanguageOf(mapped))?.familyCode
    : undefined
  const familyCode = mappedFamily ?? (value ? familyMatchingLabel(value, rows) : undefined)
  if (familyCode) return defaultCodeForFamily(familyCode, rows)
  if (rows.some((row) => row.code.toLowerCase() === INWORLD_DESIGN_DEFAULT_LOCALE.toLowerCase())) {
    return INWORLD_DESIGN_DEFAULT_LOCALE
  }
  return rows[0]?.code ?? INWORLD_DESIGN_DEFAULT_LOCALE
}

export function familyCodeOf(
  code: string,
  rows: readonly InworldSupportedLanguage[],
): string {
  const row = rowForDesignCode(code, rows)
  if (row) return row.familyCode
  return primaryLanguageOf(code)
}

export function formatDesignLanguageName(language: string, uiLocale: string): string {
  const primary = primaryLanguageOf(language)
  if (!primary) return language
  const named = INWORLD_TTS2_LANGUAGE_NAMES[primary]
  if (named) return named
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: "language" }).of(primary)
    if (name && name !== primary) return name
  } catch {
    // Intl.DisplayNames can throw on a malformed locale; fall through.
  }
  return primary
}

export function formatDesignAccentLabel(
  locale: string,
  uiLocale: string,
  named: (region: "US" | "GB" | "MX" | "BR") => string,
  standard: string,
): string {
  const region = regionOf(locale)
  if (!region) return standard
  if (region === "US" || region === "GB" || region === "MX" || region === "BR") {
    return named(region)
  }
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: "region" }).of(region)
    if (name && name !== region) return name
  } catch {
    // fall through
  }
  return region
}

export function accentLabelForRow(
  row: InworldSupportedLanguage,
  uiLocale: string,
  named: (region: "US" | "GB" | "MX" | "BR") => string,
  standard: string,
): string {
  const accent = row.accentDisplayName.trim()
  if (accent) {
    if (
      foldLabel(accent) === foldLabel(row.familyDisplayName)
      && row.displayName.trim()
      && foldLabel(row.displayName) !== foldLabel(row.familyDisplayName)
    ) {
      return row.displayName.trim()
    }
    return accent
  }
  return formatDesignAccentLabel(row.code, uiLocale, named, standard)
}
