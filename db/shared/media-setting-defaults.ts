// AQU-1768: org-level defaults for the media settings, with a project override.
//
// Same shape as countStructuralCells (AQU-1083) and the validation thresholds
// (AQU-1771): the org may set a default, a project may set its own, and a key
// ABSENT on the project means "use the org's". Absent on both falls through to
// each reader's own built-in default, which this file deliberately does not
// restate — the enforcement helpers keep their fail-safe answers (timing
// LOCKED, track editing OFF, cell editing NOBODY, self-validation ON, audio
// floor REVIEWER) exactly as before.
//
// The merge is per key and only takes values a reader would accept. A value
// this build does not recognise is treated as absent on that side, so an org
// default with a typo is ignored, and a malformed project value (the write
// routes validate, so only a hand-edited row has one) falls to the org's.
//
// PURE and dependency-free so both workers and the client can import it.

export const MEDIA_DEFAULT_KEYS = [
  "timingLocked",
  "allowTrackEditing",
  "cellEditingFloor",
  "allowSelfValidationAudio",
  "validationRoleFloorAudio",
] as const

export type MediaDefaultKey = (typeof MEDIA_DEFAULT_KEYS)[number]

export const CELL_EDITING_TIERS = [
  "none",
  "commenter",
  "reviewer",
  "contributor",
  "project_lead",
  "maintainer",
] as const

export const AUDIO_VALIDATION_ROLE_FLOORS = ["reviewer", "project_lead", "maintainer"] as const

export type MediaDefaults = {
  timingLocked?: boolean
  allowTrackEditing?: boolean
  cellEditingFloor?: (typeof CELL_EDITING_TIERS)[number]
  allowSelfValidationAudio?: boolean
  validationRoleFloorAudio?: (typeof AUDIO_VALIDATION_ROLE_FLOORS)[number]
}

/**
 * The project_settings generated column for each key (migration 0176), used to
 * count and clear project overrides without parsing every settings blob.
 */
export const MEDIA_DEFAULT_COLUMNS: Record<MediaDefaultKey, string> = {
  timingLocked: "timing_locked",
  allowTrackEditing: "allow_track_editing",
  cellEditingFloor: "cell_editing_floor",
  allowSelfValidationAudio: "allow_self_validation_audio",
  validationRoleFloorAudio: "validation_role_floor_audio",
}

/** URL slug of each key for the org "reset project overrides" endpoint. */
export const MEDIA_DEFAULT_SLUGS: Record<string, MediaDefaultKey> = {
  "timing-locked": "timingLocked",
  "allow-track-editing": "allowTrackEditing",
  "cell-editing-floor": "cellEditingFloor",
  "allow-self-validation-audio": "allowSelfValidationAudio",
  "validation-role-floor-audio": "validationRoleFloorAudio",
}

/** Is `value` something the readers of `key` accept as an explicit choice? */
export function isValidMediaDefault(key: MediaDefaultKey, value: unknown): boolean {
  switch (key) {
    case "timingLocked":
    case "allowTrackEditing":
    case "allowSelfValidationAudio":
      return typeof value === "boolean"
    case "cellEditingFloor":
      return typeof value === "string" && (CELL_EDITING_TIERS as readonly string[]).includes(value)
    case "validationRoleFloorAudio":
      return typeof value === "string" && (AUDIO_VALIDATION_ROLE_FLOORS as readonly string[]).includes(value)
  }
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

/** The org's media defaults, valid values only. Empty when it set none. */
export function mediaDefaultsFromOrgSettings(orgSettings: unknown): MediaDefaults {
  const org = asRecord(orgSettings)
  const out: Record<string, unknown> = {}
  if (!org) return out as MediaDefaults
  for (const key of MEDIA_DEFAULT_KEYS) {
    if (isValidMediaDefault(key, org[key])) out[key] = org[key]
  }
  return out as MediaDefaults
}

/**
 * The project's settings with every media key it does not set itself filled
 * from the org's default. Every other key is untouched.
 *
 * Keeps `null` for "no project settings and no org default" so the readers'
 * existing "no settings row" branch (the fail-safe answer) still runs.
 */
export function withOrgMediaDefaults(
  projectSettings: Record<string, unknown> | null,
  orgSettings: unknown,
): Record<string, unknown> | null {
  const defaults = mediaDefaultsFromOrgSettings(orgSettings) as Record<string, unknown>
  const inherited = MEDIA_DEFAULT_KEYS.filter(
    (key) => defaults[key] !== undefined && !isValidMediaDefault(key, projectSettings?.[key]),
  )
  if (inherited.length === 0) return projectSettings
  const merged: Record<string, unknown> = { ...(projectSettings ?? {}) }
  for (const key of inherited) merged[key] = defaults[key]
  return merged
}
