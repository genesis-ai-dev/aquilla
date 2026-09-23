/**
 * AQU-730 read wall — pure visibility rules.
 *
 * The wall is dark unless `LANE_READ_WALL` is "1" or "true". While it is off,
 * every caller sees every lane, which is today's behavior. Turn it on only
 * after `project_member_lane_roles` has been backfilled in that environment:
 * below Maintainer, no grant means no target lane.
 *
 * A grant below Viewer (100) does not reveal a lane. Maintainer (600) and
 * platform operators see every lane. Source text is not a lane and is never
 * hidden by these rules.
 */

import { languagesEqual } from "../language-normalize"

/** Viewer. A grant below this does not reveal a lane. Matches frontier/roles. */
const VIEWER = 100
/** Maintainer. At and above this role, every lane is visible. */
const MAINTAINER = 600

export interface LaneGrant {
  lane: string
  level: number
}

/** null = every lane. A set is the exact set of granted tags (may be empty). */
export type VisibleLaneTags = ReadonlySet<string> | null

export function laneReadWallEnabled(flag: string | undefined): boolean {
  return flag === "1" || flag === "true"
}

export function visibleLaneTags(input: {
  enabled: boolean
  role: number
  src?: string
  laneGrants?: readonly LaneGrant[] | null
}): VisibleLaneTags {
  if (!input.enabled) return null
  if (input.src === "platform") return null
  if (input.role >= MAINTAINER) return null
  const tags = new Set<string>()
  for (const grant of input.laneGrants ?? []) {
    if (typeof grant.lane !== "string") continue
    if (grant.level < VIEWER) continue
    tags.add(grant.lane)
  }
  return tags
}

export interface LaneIdentity {
  id: string
  name: string
  /** `''` is the default target lane. Null is treated the same. */
  legacyTag: string | null
}

/**
 * A grant matches a lane by its tag or its name (`es` ≡ Spanish). An empty
 * grant matches only the empty-tag lane, never a named language.
 */
export function laneMatchesGrant(lane: LaneIdentity, grant: string): boolean {
  const tag = lane.legacyTag ?? ""
  if (grant === "") return tag === ""
  if (tag !== "" && languagesEqual(grant, tag)) return true
  return lane.name.trim() !== "" && languagesEqual(grant, lane.name)
}

/**
 * One grant reveals one lane. A grant that matches two lanes reveals neither
 * of them — a maintainer has to separate those lanes. Two explicit grants
 * still reveal two lanes, one each.
 */
export function uniqueLaneIdsForGrants(lanes: readonly LaneIdentity[], grants: Iterable<string>): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const grant of grants) {
    const matches = lanes.filter((lane) => laneMatchesGrant(lane, grant))
    if (matches.length !== 1) continue
    const id = matches[0]!.id
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Whether a requested lane tag is in the visible set. `es` and `Spanish`
 * match. The empty default-lane tag matches only an empty grant — the lane's
 * display name is checked separately, against the `lanes` row.
 */
export function laneTagAllowed(visible: VisibleLaneTags, tag: string): boolean {
  if (visible === null) return true
  for (const grant of visible) {
    if (grant === tag) return true
    if (grant !== "" && tag !== "" && languagesEqual(grant, tag)) return true
  }
  return false
}

/** Stable ETag / cache suffix. Empty when the caller is unrestricted. */
export function visibilityCacheToken(visible: VisibleLaneTags): string {
  if (visible === null) return ""
  const tags = [...visible].map((tag) => encodeURIComponent(tag)).sort()
  return `:vis:${tags.join(".")}`
}

/**
 * Labels a grant may show. A grant that matches two different labels shows
 * neither, so `Spanish` and `es` side by side are not both revealed.
 */
function uniqueLabelsForGrants(labels: readonly string[], grants: Iterable<string>): Set<string> {
  const distinct = [...new Set(labels.filter((label) => label !== ""))]
  const kept = new Set<string>()
  for (const grant of grants) {
    if (grant === "") continue
    const matches = distinct.filter((label) => label === grant || languagesEqual(grant, label))
    if (matches.length === 1) kept.add(matches[0]!)
  }
  return kept
}

/**
 * Drop lane names the caller was not granted. `visible === null` returns the
 * response unchanged. An ungranted `targetLanguage` is blanked because that
 * string is the default lane's name.
 */
export function filterSettingsToVisibleLanes<T extends { settings: Record<string, unknown> }>(
  response: T,
  visible: VisibleLaneTags,
): T {
  if (visible === null) return response
  const settings: Record<string, unknown> = { ...response.settings }
  const primary = settings.targetLanguage
  const labels: string[] = []
  if (typeof primary === "string" && primary.trim() !== "") labels.push(primary)
  for (const key of ["targetLanes", "archivedLanes"] as const) {
    const value = settings[key]
    if (!Array.isArray(value)) continue
    for (const lane of value) if (typeof lane === "string") labels.push(lane)
  }
  const kept = uniqueLabelsForGrants(labels, visible)
  for (const key of ["targetLanes", "archivedLanes"] as const) {
    const value = settings[key]
    if (!Array.isArray(value)) continue
    settings[key] = value.filter((lane) => typeof lane === "string" && kept.has(lane))
  }
  if (typeof primary === "string" && primary.trim() !== "" && !kept.has(primary)) {
    settings.targetLanguage = ""
  }
  return { ...response, settings }
}
