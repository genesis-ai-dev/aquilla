// AQU-1573: which reference Bible a lane quotes from.
//
// Setting `referenceBibleVersions` (project_settings JSON) is a map from lane
// tag to Bible id — one Bible per target language (Sam, 2026-10-02):
//
//   { "": "arb-vandyck", "en": "eng-kjv" }
//
// "" is the default lane, the convention rule lane-scoping and `targetLang`
// already use. A key naming the primary language ("Arabic", or "ar" when the
// project's targetLanguage is Arabic) also means the default lane, through
// canonicalLaneId (AQU-1532), so an agent that writes { "Arabic": … } gets
// what it meant. The ticket's own form, a one-item array ["arb-vandyck"], is
// accepted and means "the default lane uses this Bible".
//
// No path aliases: auth-worker imports this file too (see types.ts).

import { canonicalLaneId } from "../lanes/registry-lanes"

export type ReferenceBibleMap = Record<string, string>

export interface ReferenceBibleSettings {
  referenceBibleVersions?: unknown
  targetLanguage?: unknown
}

function targetLanguageOf(settings: ReferenceBibleSettings | null | undefined): string | null {
  return typeof settings?.targetLanguage === "string" ? settings.targetLanguage : null
}

/**
 * The stored value as a lane → id map, or null when it is not a shape the
 * setting accepts. Absent/null reads as an empty map.
 */
export function parseReferenceBibleSetting(value: unknown): ReferenceBibleMap | null {
  if (value === undefined || value === null) return {}
  if (Array.isArray(value)) {
    if (value.length === 0) return {}
    if (value.length === 1 && typeof value[0] === "string" && value[0].trim()) return { "": value[0].trim() }
    return null
  }
  if (typeof value !== "object") return null
  const out: ReferenceBibleMap = {}
  for (const [lane, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id !== "string" || !id.trim()) return null
    out[lane.trim()] = id.trim()
  }
  return out
}

/** Why `value` is not a valid setting shape, or null when it is. */
export function referenceBibleSettingShapeProblem(value: unknown): string | null {
  if (Array.isArray(value) && value.length > 1) {
    return "one Bible per lane — use { laneTag: versionId } (\"\" is the default lane)"
  }
  return parseReferenceBibleSetting(value) === null
    ? "expected { laneTag: versionId } (\"\" is the default lane) or a one-item array [versionId]"
    : null
}

/** The lane the setting key or lane tag refers to, with the primary language folded to "". */
function laneKey(lane: string | null | undefined, targetLanguage: string | null): string {
  return canonicalLaneId((lane ?? "").trim(), targetLanguage)
}

/** The Bible id `lane` quotes from, or null. `lane` "" / null / undefined = default lane. */
export function referenceBibleForLane(
  settings: ReferenceBibleSettings | null | undefined,
  lane: string | null | undefined,
): string | null {
  const map = parseReferenceBibleSetting(settings?.referenceBibleVersions)
  if (!map) return null
  const target = targetLanguageOf(settings)
  const want = laneKey(lane, target)
  if (map[want]) return map[want]
  for (const [key, id] of Object.entries(map)) {
    if (laneKey(key, target) === want || key.toLowerCase() === want.toLowerCase()) return id
  }
  return null
}

/**
 * The setting after choosing `versionId` (or none) for `lane`. The array form
 * becomes a map, other keys for the same lane (aliases) are removed, and the
 * result is always a map — `{}` clears every lane, so the UI never writes a
 * null the settings overlay would skip.
 */
export function withReferenceBibleForLane(
  value: unknown,
  lane: string | null | undefined,
  versionId: string | null,
  targetLanguage: string | null | undefined,
): ReferenceBibleMap {
  const map = parseReferenceBibleSetting(value) ?? {}
  const target = targetLanguage ?? null
  const want = laneKey(lane, target)
  const out: ReferenceBibleMap = {}
  for (const [key, id] of Object.entries(map)) {
    if (laneKey(key, target) === want || key.toLowerCase() === want.toLowerCase()) continue
    out[key] = id
  }
  if (versionId) out[want] = versionId
  return out
}
