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

import { laneOptionLabel, type LaneLanguageRow } from "@/lib/lanes/lane-language"

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
 * AQU-1977: one of the project's own target lanes, as an assign surface offers
 * it. `legacyTag` is what `assignment.create` still sends; `''` is an old
 * project's former default lane, which is an ordinary option like any other.
 */
export interface AssignLaneOption {
  legacyTag: string
  label: string
  /**
   * AQU-1994: the lane row's id, which is what a lane GRANT names. Optional
   * because the portfolio's lane rows predate it on an older server — an
   * option without one cannot be judged against a staffing set and is kept.
   */
  laneId?: string
}

/**
 * AQU-1977: the assign options for a project's lane rows — its live target
 * lanes in position order, each labelled by name. Archived lanes are left out,
 * and so is a tagless lane, which a tag cannot name.
 */
export function assignLaneOptions(
  rows:
    | readonly (LaneLanguageRow & { position?: number; archivedAt?: string | null })[]
    | null
    | undefined,
  fallback: string,
): AssignLaneOption[] {
  return (rows ?? [])
    .filter((row) => row.role !== "source" && row.legacyTag !== null && !row.archivedAt)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))
    .map((row) => ({
      legacyTag: row.legacyTag ?? "",
      label: laneOptionLabel(row, fallback),
      laneId: row.id,
    }))
}

/**
 * AQU-1994: the lane options at least one person on the project is on.
 *
 * `staffedLaneIds` is `null`/`undefined` when the server did not say — an
 * older server, a caller below project lead, a project with no lane rows, or
 * a failed read. Unknown is NOT "nobody is staffed", so the list is returned
 * untouched. A known set narrows to the lanes it names; an option with no
 * `laneId` is kept, since staffing cannot speak to a lane it cannot identify.
 *
 * Narrowing is by lane id, not by tag: two lanes can share a legacy tag, and
 * only one of them may be staffed.
 */
export function lanesStaffedBy(
  lanes: readonly AssignLaneOption[],
  staffedLaneIds: readonly string[] | ReadonlySet<string> | null | undefined,
): readonly AssignLaneOption[] {
  if (staffedLaneIds == null) return lanes
  const staffed =
    staffedLaneIds instanceof Set
      ? (staffedLaneIds as ReadonlySet<string>)
      : new Set(staffedLaneIds as readonly string[])
  return lanes.filter((lane) => lane.laneId == null || staffed.has(lane.laneId))
}

/**
 * One attached team's lane checks (AQU-2047).
 *
 * `lanesExplicit` false is a living attachment: the team is tied to every
 * current target lane, including one created later, until someone saves the
 * checkboxes. `true` is the saved set, and `laneIds` are those lanes.
 */
export interface TeamLaneAttachment {
  lanesExplicit: boolean
  laneIds?: readonly string[]
}

/**
 * AQU-2047: the lane options the project's attached teams are tied to.
 *
 * `teams` is `null`/`undefined` when the server did not say. Unknown is NOT
 * "no lanes", so the list is returned untouched — the same convention as
 * {@link lanesStaffedBy}. An empty list is a project with no attached team,
 * which keeps today's menu.
 *
 * A team that has not saved checkboxes (`lanesExplicit` false) is tied to
 * every current target lane. One such team among several means the union is
 * every current lane: nothing here is removed. When every attached team has
 * saved a set, a lane stays if any of them checked it.
 *
 * An option with no `laneId` is kept. The check is by lane id, and a lane
 * this list cannot identify is not one it can call irrelevant.
 */
export function lanesTiedToTeams(
  lanes: readonly AssignLaneOption[],
  teams: readonly TeamLaneAttachment[] | null | undefined,
): readonly AssignLaneOption[] {
  if (teams == null || teams.length === 0) return lanes
  if (teams.some((team) => !team.lanesExplicit)) return lanes
  const allowed = new Set<string>()
  for (const team of teams) {
    for (const laneId of team.laneIds ?? []) allowed.add(laneId)
  }
  return lanes.filter((lane) => lane.laneId == null || allowed.has(lane.laneId))
}

/**
 * Lane options for an assign surface (AQU-1601).
 *
 * A project with one lane names it; hiding the field there taught people there
 * was nothing to add. AQU-581: a non-empty `allowedTags` list keeps only those
 * raw tags (`''` is the default lane). An empty list is not a filter — a lead
 * keeps every lane.
 *
 * AQU-1977: given the project's own `lanes`, those are the options, in order,
 * and nothing else. Without them the old shape stands — a default (`''`) lane
 * first, then each of `targetLanes` — which on a project made since AQU-1594
 * offered a "Default language" the project does not have: chosen, it saved an
 * assignment that belongs to no lane, whose progress always reads 0.
 *
 * AQU-1994: `staffedLaneIds` narrows the project's own lanes to the ones at
 * least one person on the project is on, so a manager cannot route work to a
 * language nobody has access to. It applies only to the `lanes` branch, where
 * every option knows its lane id — the legacy `targetLanes` shape has no ids
 * to match a grant against. `null`/`undefined` means the server did not say,
 * which is NOT "nobody": the full list stands. A known set that matches
 * nothing narrows to zero options, and an assign surface must refuse rather
 * than offer lanes no one can work in.
 *
 * AQU-2047: `teamLanes` is the same cut for a team's saved lane checks. It
 * applies only on the `lanes` branch, beside staffing, and a lane must pass
 * both when both inputs are present. `null`/`undefined` and an empty list
 * narrow nothing — a missing read, or a project with no attached team.
 */
export function buildLaneItems(input: {
  lanes?: readonly AssignLaneOption[] | null
  targetLanes?: readonly string[] | null
  laneLabels?: Readonly<Record<string, string>> | null
  defaultLaneLabel?: string | null
  defaultLaneFallback: string
  allowedTags?: readonly string[] | null
  staffedLaneIds?: readonly string[] | ReadonlySet<string> | null
  teamLanes?: readonly TeamLaneAttachment[] | null
}): AssignmentLaneItem[] {
  const extra = (input.targetLanes ?? []).filter((lane) => !isDefaultLaneValue(lane))
  const defaultLabel =
    input.laneLabels?.[""]?.trim() ||
    input.defaultLaneLabel?.trim() ||
    input.defaultLaneFallback
  const laneRows = input.lanes?.length
    ? lanesTiedToTeams(lanesStaffedBy(input.lanes, input.staffedLaneIds), input.teamLanes)
    : null
  const all: AssignmentLaneItem[] = laneRows
    ? laneRows.map((lane) => ({ value: selectValueForLane(lane.legacyTag), label: lane.label }))
    : [
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
