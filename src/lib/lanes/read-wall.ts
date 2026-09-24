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

function listed(lane: string, visible: ReadonlySet<string>): boolean {
  for (const grant of visible) {
    if (grant === lane) return true
    if (grant !== "" && lane !== "" && languagesEqual(grant, lane)) return true
  }
  return false
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
  for (const key of ["targetLanes", "archivedLanes"] as const) {
    const value = settings[key]
    if (!Array.isArray(value)) continue
    settings[key] = value.filter((lane) => typeof lane === "string" && listed(lane, visible))
  }
  const primary = settings.targetLanguage
  if (typeof primary === "string" && primary.trim() !== "" && !listed(primary, visible) && !visible.has("")) {
    settings.targetLanguage = ""
  }
  return { ...response, settings }
}
