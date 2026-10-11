// AQU-1840: the project-settings keys POST /events reads, and nothing else.
//
// The events route used to answer every authority question out of one
// `SELECT settings FROM project_settings` + `JSON.parse` — a column the table's
// own comment calls multi-MB, detoasted and shipped to the Worker on every
// autosave flush just to ask "is this lane archived?". Migration 0159 projects
// these eleven keys into STORED generated `wp_*` columns, so the write path
// reads one narrow row instead.
//
// This type is deliberately CLOSED: a key that is not listed here is not
// projected, so reading one off this object would silently be `undefined`
// rather than the value in the blob. Adding a key the write path needs means
// adding it here, to `WRITE_PATH_COLUMNS`, to the schema and to a migration —
// in that order the compiler will not let you forget one.
//
// Every field is `unknown` on purpose. The consumers guard their own types
// (`typeof === 'number'`, `=== true`, `!== false`, `Array.isArray`), and those
// guards are the contract — see the migration header for why projecting
// through `->>` TEXT instead of `->` JSONB would break them.

/** The keys the events write path reads out of `project_settings.settings`. */
export interface WritePathSettings {
  /** Legacy mirror of the archived-lane list: tags, never the `''` lane. */
  archivedLanes?: unknown
  /** Unlocks the timeline only when exactly `false` (timing-authority.ts). */
  timingLocked?: unknown
  /** Opts into timeline restructuring only when exactly `true`. */
  allowTrackEditing?: unknown
  /** Validator threshold; honoured only when a number >= 1. */
  validationCount?: unknown
  validationRoleFloor?: unknown
  validationNamedUsers?: unknown
  allowSelfValidation?: unknown
  validationRoleFloorAudio?: unknown
  validationNamedUsersAudio?: unknown
  allowSelfValidationAudio?: unknown
  harmonize_min_role?: unknown
}

/**
 * `wp_` column -> settings key. The column list IS the SELECT, so the query
 * and the object can never fall out of step.
 */
export const WRITE_PATH_COLUMNS: Readonly<Record<string, keyof WritePathSettings>> = {
  wp_archived_lanes: 'archivedLanes',
  wp_timing_locked: 'timingLocked',
  wp_allow_track_editing: 'allowTrackEditing',
  wp_validation_count: 'validationCount',
  wp_validation_role_floor: 'validationRoleFloor',
  wp_validation_named_users: 'validationNamedUsers',
  wp_allow_self_validation: 'allowSelfValidation',
  wp_validation_role_floor_audio: 'validationRoleFloorAudio',
  wp_validation_named_users_audio: 'validationNamedUsersAudio',
  wp_allow_self_validation_audio: 'allowSelfValidationAudio',
  wp_harmonize_min_role: 'harmonize_min_role',
}

/** The projected columns, in SELECT order. */
export const WRITE_PATH_COLUMN_LIST: readonly string[] = Object.keys(WRITE_PATH_COLUMNS)

/**
 * The `wp_*` row as the write path's view of the blob.
 *
 * A projected column is NULL both when the key is absent and when it holds JSON
 * `null`; the key is then omitted, which is what every consumer's guard already
 * treats as unset.
 *
 * Values are passed through EXACTLY as the driver hands them over, never
 * re-parsed. `->` keeps the value's JSON type and both drivers in play
 * (postgres.js in the workers, PGlite in these tests) parse a JSONB column into
 * the JS value `JSON.parse(settings)` would have produced — so `timingLocked`
 * arrives as a boolean and the string `"false"` arrives as the string
 * `'false'`, which is the distinction the lock turns on. Re-parsing a string to
 * "recover" a text-delivered JSONB document would erase exactly that
 * distinction and unlock a locked timeline. A driver that did deliver JSONB as
 * text would simply fail every consumer's type guard, and each one's unset
 * default is its restrictive answer (locked / off / no threshold).
 */
export function writePathSettingsFromRow(row: Record<string, unknown>): WritePathSettings {
  const out: Record<string, unknown> = {}
  for (const [column, key] of Object.entries(WRITE_PATH_COLUMNS)) {
    const raw = row[column]
    if (raw === null || raw === undefined) continue
    out[key] = raw
  }
  return out as WritePathSettings
}
