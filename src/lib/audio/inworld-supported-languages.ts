// Inworld Voice Design language catalog.
//
// Source of truth: GET https://api.inworld.ai/voices/v1/supportedLanguages
// (proxied as GET /api/v1/voice/tts/supported-languages). Keep parseInworldSupportedLanguages
// in sync with sync-worker/src/inworld-supported-languages.ts.

import { INWORLD_LANGUAGE_CODES } from "./inworld-languages"
import { INWORLD_TTS2_LANGUAGE_CODES, INWORLD_TTS2_LANGUAGE_NAMES } from "./inworld-tts2-languages"

export interface InworldSupportedLanguage {
  code: string
  familyCode: string
  familyDisplayName: string
  accentDisplayName: string
  displayName: string
  creationEnabled: boolean
  hasVoices: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseOne(row: unknown): InworldSupportedLanguage | null {
  const o = asRecord(row)
  if (!o) return null
  const code = typeof o.code === "string" ? o.code.trim() : ""
  if (!code || code.toLowerCase() === "und") return null
  if (o.creationEnabled === false) return null
  const familyCode = (typeof o.familyCode === "string" && o.familyCode.trim())
    || code.split("-")[0]
    || code
  const familyDisplayName = (typeof o.familyDisplayName === "string" && o.familyDisplayName.trim())
    || familyCode
  const accentDisplayName = typeof o.accentDisplayName === "string" ? o.accentDisplayName.trim() : ""
  const displayName = (typeof o.displayName === "string" && o.displayName.trim()) || familyDisplayName
  return {
    code,
    familyCode,
    familyDisplayName,
    accentDisplayName,
    displayName,
    creationEnabled: true,
    hasVoices: o.hasVoices === true,
  }
}

/** Accept Inworld `{ supportedLanguages }` or our worker `{ languages }`. */
export function parseInworldSupportedLanguages(payload: unknown): InworldSupportedLanguage[] {
  const root = asRecord(payload)
  const raw = Array.isArray(root?.supportedLanguages) ? root.supportedLanguages
    : Array.isArray(root?.languages) ? root.languages
    : Array.isArray(payload) ? payload
    : []
  const out: InworldSupportedLanguage[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    const parsed = parseOne(row)
    if (!parsed) continue
    const key = parsed.code.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(parsed)
  }
  return out
}

function englishLanguageName(code: string): string {
  const named = INWORLD_TTS2_LANGUAGE_NAMES[code]
  if (named) return named
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code)
    if (name && name !== code) return name
  } catch {
    // fall through
  }
  return code
}

/** Published TTS-2 table + stock shortlist — used when Inworld is unreachable. */
export function fallbackDesignLanguages(): InworldSupportedLanguage[] {
  const out: InworldSupportedLanguage[] = []
  const seen = new Set<string>()
  const add = (code: string) => {
    const trimmed = code.trim()
    if (!trimmed) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const familyCode = trimmed.split("-")[0]?.toLowerCase() || trimmed
    const familyDisplayName = englishLanguageName(familyCode)
    out.push({
      code: trimmed,
      familyCode,
      familyDisplayName,
      accentDisplayName: "",
      displayName: familyDisplayName,
      creationEnabled: true,
      hasVoices: true,
    })
  }
  for (const code of INWORLD_TTS2_LANGUAGE_CODES) add(code)
  for (const code of INWORLD_LANGUAGE_CODES) add(code)
  return out
}
