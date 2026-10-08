/**
 * AQU-1615 / AQU-1595: project settings no longer carry a language pair or a
 * lane registry. One list, one message — the external commands and the in-app
 * settings route both refuse these keys and point the caller at lane rows.
 *
 * Stored blobs may still hold the keys. A write that omits them keeps the
 * stored values (history is not rewritten). A write that includes any of them
 * is rejected.
 */

export const RETIRED_LANE_SETTINGS_KEYS = [
  "sourceLanguage",
  "targetLanguage",
  "targetLanes",
  "archivedLanes",
] as const

export type RetiredLaneSettingsKey = (typeof RETIRED_LANE_SETTINGS_KEYS)[number]

export const RETIRED_LANE_SETTINGS_MESSAGE =
  "sourceLanguage, targetLanguage, targetLanes, and archivedLanes are not settings. " +
  "Create lanes with CreateProject or ProjectSetup " +
  "(lanes: [{ role, language, name?, code? }]) and address a lane by its id."

export function includesRetiredLaneSettings(settings: object): boolean {
  return RETIRED_LANE_SETTINGS_KEYS.some((key) => key in settings)
}

/**
 * Copy the stored retired keys onto `incoming` so a whole-blob replace that
 * omitted them does not delete history. Incoming must already have been
 * rejected if it included any of the keys.
 */
export function preserveRetiredLaneSettings(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...incoming }
  for (const key of RETIRED_LANE_SETTINGS_KEYS) {
    if (key in stored) next[key] = stored[key]
    else delete next[key]
  }
  return next
}
