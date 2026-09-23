// Inworld language tags for catalog fetch + synthesize (AQU-1189).
//
// Keep `toInworldLanguage` in sync with sync-worker/src/inworld-tts.ts.
// Project lanes may be free-form labels ("French", "Grade 7 English") that
// Inworld cannot map; if any lane is unrecognized, the New Voice dialog asks
// the user to pick a code.

import { LANGUAGES } from "@/lib/languages/catalog"
import type { Voice } from "@/lib/parsers/types"

const ISO_639_3_TO_BCP47: Record<string, string> = {
  ara: "ar",
  deu: "de-DE",
  eng: "en-US",
  spa: "es-ES",
  fra: "fr-FR",
  hin: "hi-IN",
  kor: "ko-KR",
  por: "pt-BR",
  ron: "ro-RO",
  rus: "ru-RU",
  vie: "vi-VN",
  yor: "yo",
  zho: "zh-CN",
  cmn: "zh-CN",
}

/** Stock Inworld TTS languages offered when a lane label cannot be mapped. */
export const INWORLD_LANGUAGE_CODES = [
  "ar",
  "ar-SA",
  "zh-CN",
  "nl-NL",
  "en-GB",
  "en-US",
  "fr-FR",
  "de-DE",
  "he-IL",
  "hi-IN",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ro-RO",
  "ru-RU",
  "es-MX",
  "es-ES",
  "vi-VN",
  "yo",
] as const

export const INWORLD_LANGUAGE_OTHER = "__other__"

export function isListedInworldLanguage(value: string | undefined): boolean {
  const mapped = toInworldLanguage(value)
  if (!mapped) return false
  return INWORLD_LANGUAGE_CODES.some((code) => code.toLowerCase() === mapped.toLowerCase())
}

/** Map project language tags (eng, en, en-US, EN_GB) onto Inworld's BCP-47. */
export function toInworldLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === "auto") return undefined
  const normalized = trimmed.replace(/_/g, "-")
  const lower = normalized.toLowerCase()
  if (ISO_639_3_TO_BCP47[lower]) return ISO_639_3_TO_BCP47[lower]
  const primary = lower.split("-")[0]
  if (primary && ISO_639_3_TO_BCP47[primary]) {
    return normalized.includes("-") ? normalized : ISO_639_3_TO_BCP47[primary]
  }
  // ISO 639-1 (2) or ISO 639-3 (3, e.g. fil, yue, ceb) plus optional subtags.
  if (/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(normalized)) return normalized
  return undefined
}

/**
 * Prefer a stock Inworld tag (`en-US`, `fr-FR`) when the mapped code is only
 * a primary language (`en`, `fr`). Exact listed tags (`en-GB`) stay as-is.
 */
export function preferListedInworldLanguage(code: string): string {
  const mapped = toInworldLanguage(code) ?? code.trim()
  if (!mapped) return code
  const listedExact = INWORLD_LANGUAGE_CODES.find((c) => c.toLowerCase() === mapped.toLowerCase())
  if (listedExact) return listedExact
  const primary = mapped.split("-")[0]?.toLowerCase()
  if (!primary) return mapped
  const fromIso = Object.values(ISO_639_3_TO_BCP47).find((c) => {
    const lower = c.toLowerCase()
    return lower === primary || lower.startsWith(`${primary}-`)
  })
  if (fromIso) {
    const listedIso = INWORLD_LANGUAGE_CODES.find((c) => c.toLowerCase() === fromIso.toLowerCase())
    if (listedIso) return listedIso
  }
  const listedFamily = INWORLD_LANGUAGE_CODES.find((c) => {
    const lower = c.toLowerCase()
    return lower === primary || lower.startsWith(`${primary}-`)
  })
  return listedFamily ?? mapped
}

/**
 * Loose persist-time mapping: ISO-639-3, BCP-47, 2-letter codes, and catalog
 * display names (`French` → `fr-FR`). Unmapped labels (`Grade 7 English`)
 * return undefined so the caller can keep the original.
 */
export function toInworldLanguageLoose(value: string | undefined): string | undefined {
  const direct = toInworldLanguage(value)
  if (direct) return preferListedInworldLanguage(direct)
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const folded = foldLanguageLabel(trimmed)
  const catalog = LANGUAGES.find(
    (entry) => foldLanguageLabel(entry.name) === folded || foldLanguageLabel(entry.code) === folded,
  )
  if (!catalog) return undefined
  const mapped = toInworldLanguage(catalog.code)
  return mapped ? preferListedInworldLanguage(mapped) : undefined
}

export function needsInworldLanguagePicker(lanes: readonly string[]): boolean {
  const nonempty = lanes.map((lane) => lane.trim()).filter(Boolean)
  if (nonempty.length === 0) return false
  return nonempty.some((lane) => !toInworldLanguage(lane))
}

/** Languages to send to GET /voices: mapped lanes, plus a user-chosen fallback. */
export function catalogLanguagesForInworld(
  lanes: readonly string[],
  chosenLanguage?: string,
): string[] {
  const mapped: string[] = []
  const add = (code: string | undefined) => {
    if (!code) return
    if (mapped.some((existing) => existing.toLowerCase() === code.toLowerCase())) return
    mapped.push(code)
  }
  for (const lane of lanes) add(toInworldLanguage(lane))
  add(toInworldLanguage(chosenLanguage))
  return mapped
}

/** Prefer a saved Inworld voice language over the (possibly unmapped) lane tag. */
export function inworldLanguageForRequest(
  voice: Pick<Voice, "language">,
  laneLanguage?: string,
): string | undefined {
  return toInworldLanguage(voice.language) ?? toInworldLanguage(laneLanguage)
}

export function formatInworldLanguageLabel(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code)
    if (name && name !== code) return `${name} (${code})`
  } catch {
    // Intl.DisplayNames can throw on a malformed locale; fall through.
  }
  return code
}

function foldLanguageLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

function displayNameForCode(code: string, locale: string): string | undefined {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code)
    if (name && name !== code) return name
  } catch {
    // Intl.DisplayNames can throw on a malformed locale; fall through.
  }
  return undefined
}

/** Display name only (no BCP-47), for the compact Voices-row description. */
export function formatVoiceLanguageName(code: string, locale: string): string {
  const trimmed = code.trim()
  if (!trimmed) return ""
  const mapped = toInworldLanguage(trimmed)
  if (mapped) return displayNameForCode(mapped, locale) ?? mapped
  const folded = foldLanguageLabel(trimmed)
  const catalog = LANGUAGES.find(
    (entry) => foldLanguageLabel(entry.name) === folded || foldLanguageLabel(entry.code) === folded,
  )
  if (catalog) return displayNameForCode(catalog.code, locale) ?? catalog.name
  return trimmed
}

/**
 * Language shown under a voice name. Prefer the voice's own tag; otherwise
 * the active target-language lane so Narrator still shows English / French / …
 */
export function languageForVoiceDescription(
  voiceLanguage: string | undefined,
  fallbackLanguage: string | undefined,
): string | undefined {
  const own = voiceLanguage?.trim()
  if (own) return own
  const fallback = fallbackLanguage?.trim()
  return fallback || undefined
}
