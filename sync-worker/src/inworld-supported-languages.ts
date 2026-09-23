// Inworld Voice Design language catalog.
// GET https://api.inworld.ai/voices/v1/supportedLanguages
// Keep parseInworldSupportedLanguages in sync with src/lib/audio/inworld-supported-languages.ts.

import { inworldApiBase, inworldAuthHeader, type InworldTtsConfig } from "./inworld-tts"

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

async function readInworldError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "")
  const trimmed = text.trim()
  if (!trimmed) return `HTTP ${res.status}`
  try {
    const json = JSON.parse(trimmed) as { message?: string; error?: string }
    return json.message || json.error || trimmed.slice(0, 500)
  } catch {
    return trimmed.slice(0, 500)
  }
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

export async function listInworldSupportedLanguages(
  config: InworldTtsConfig,
): Promise<InworldSupportedLanguage[]> {
  let res: Response
  try {
    res = await fetch(`${inworldApiBase(config)}/voices/v1/supportedLanguages`, {
      method: "GET",
      headers: { Authorization: inworldAuthHeader(config.apiKey) },
    })
  } catch (err) {
    throw new Error(`Inworld supported languages unreachable: ${String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`Inworld supported languages failed (${res.status}): ${await readInworldError(res)}`)
  }
  const json: unknown = await res.json()
  const languages = parseInworldSupportedLanguages(json)
  if (languages.length === 0) {
    throw new Error("Inworld supported languages returned no languages")
  }
  return languages
}
