/**
 * AQU-729: the product has no lane named "default".
 *
 * The default target lane is the empty string (`''`). Extra lanes are real
 * tags ("Swahili", "es"). Base UI Select treats a value that serializes to
 * `''` as "nothing selected", so the assign dialog cannot use `''` as the
 * option value — that is what made the preselected lane read as "default"
 * and kept the assignment from being identifiable as a language lane.
 *
 * The select uses a non-empty sentinel. On the way out, the sentinel and any
 * literal "default" token collapse back to "omit targetLang", which the
 * server stores as `''`. The display name of the default lane (the project's
 * target language) is a label, never a stored tag.
 */

/** Non-empty select value for the default (`''`) lane. Never persisted. */
export const DEFAULT_LANE_SELECT_VALUE = "__default__"

const UNSTORED_LANE_TOKENS = new Set([
  "",
  "default",
  "default language",
  DEFAULT_LANE_SELECT_VALUE,
])

/** True when this string is not a real extra-lane tag and must not be stored. */
export function isDefaultLaneValue(value: string | null | undefined): boolean {
  return UNSTORED_LANE_TOKENS.has((value ?? "").trim().toLowerCase())
}

/**
 * Lane tag for `assignment.create`. `undefined` is the default lane: omit it
 * on the wire so the server stores `''`. Never returns "default", the select
 * sentinel, or a display name.
 */
export function laneTagForAssignment(value: string | null | undefined): string | undefined {
  if (isDefaultLaneValue(value)) return undefined
  return (value ?? "").trim()
}

/** Select value for a stored lane. `''` and unstored tokens become the sentinel. */
export function selectValueForLane(lane: string | null | undefined): string {
  if (isDefaultLaneValue(lane)) return DEFAULT_LANE_SELECT_VALUE
  return (lane ?? "").trim()
}
