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

export interface AssignmentLaneItem {
  /** Select value. The default lane is {@link DEFAULT_LANE_SELECT_VALUE}, never `''`. */
  value: string
  label: string
}

/**
 * Lane options for an assign surface (AQU-1601).
 *
 * The default lane is always an option. A project with one lane names it;
 * hiding the field there taught people there was nothing to add. AQU-581: a
 * non-empty `allowedTags` list keeps only those raw tags (`''` is the default
 * lane). An empty list is not a filter — a lead keeps every lane.
 */
export function buildLaneItems(input: {
  targetLanes?: readonly string[] | null
  laneLabels?: Readonly<Record<string, string>> | null
  defaultLaneLabel?: string | null
  defaultLaneFallback: string
  allowedTags?: readonly string[] | null
}): AssignmentLaneItem[] {
  const extra = (input.targetLanes ?? []).filter((lane) => !isDefaultLaneValue(lane))
  const defaultLabel =
    input.laneLabels?.[""]?.trim() ||
    input.defaultLaneLabel?.trim() ||
    input.defaultLaneFallback
  const all: AssignmentLaneItem[] = [
    { value: DEFAULT_LANE_SELECT_VALUE, label: defaultLabel },
    ...extra.map((lane) => ({
      value: lane,
      label: input.laneLabels?.[lane]?.trim() || lane,
    })),
  ]
  const allowed = (input.allowedTags ?? []).filter((tag) => tag != null)
  if (allowed.length === 0) return all
  return all.filter((item) => allowed.includes(laneTagForAssignment(item.value) ?? ""))
}

/**
 * Which option an assign field opens on (AQU-1601).
 *
 * One option is that option. Several options pre-fill only from the lane the
 * user arrived from. Arriving from all lanes (`arrivedLane === null`) pre-fills
 * nothing — the first option is not a silent default.
 */
export function initialAssignmentLane(
  items: readonly { value: string }[],
  arrivedLane: string | null,
): string | null {
  if (items.length === 1) return items[0]!.value
  if (items.length === 0 || arrivedLane === null) return null
  const value = selectValueForLane(arrivedLane)
  return items.some((item) => item.value === value) ? value : null
}

/**
 * The lane row id for a tag the picker already chose.
 *
 * Matching is on `legacy_tag` (`''` is the default lane), the frozen event
 * key. The id is what the assignment sends. No row (the project has not been
 * backfilled yet) returns undefined so the tag still goes out alone.
 */
export function laneIdForTag(
  tag: string | null | undefined,
  lanes: readonly { id: string; legacyTag: string | null }[] | null | undefined,
): string | undefined {
  if (!lanes || lanes.length === 0) return undefined
  const want = isDefaultLaneValue(tag) ? "" : (tag ?? "").trim()
  const matches = lanes.filter((lane) => (lane.legacyTag ?? "") === want)
  if (matches.length !== 1) return undefined
  return matches[0]!.id
}
