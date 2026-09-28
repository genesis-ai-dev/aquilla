/**
 * AQU-730 read wall — pure visibility rules.
 *
 * The wall is on when `LANE_READ_WALL` is "1" or "true". Deployed dev and prod
 * set that in wrangler. Local and e2e leave it unset, so every caller still
 * sees every lane. Below Maintainer, no grant means no target lane — the
 * grant phase of scripts/neon-backfill-lanes.ts has to have been applied in
 * that environment before the workers that set the flag are deployed.
 *
 * A grant is a lane id. The screen shows that lane's name, which may be the
 * language. A grant below Viewer (100) does not reveal a lane. Maintainer (600) and
 * platform operators see every lane. Source text is not a lane and is never
 * hidden by these rules.
 */

/** Viewer. A grant below this does not reveal a lane. Matches frontier/roles. */
const VIEWER = 100
/** Maintainer. At and above this role, every lane is visible. */
const MAINTAINER = 600

/** `lane` is `lanes.id`, never a language name or code. */
export interface LaneGrant {
  lane: string
  level: number
}

/** null = every lane. A set is granted lane ids (may be empty). */
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
 * The lane a caller asked for by its legacy tag or its display name.
 * `''` is only the empty-tag lane. A string that hits two lanes hits neither
 * decision here — the caller must see `length === 1` before allowing it.
 * Language codes do not fan out: "es" does not match a lane named Spanish
 * unless that lane's tag or name is exactly "es".
 */
export function lanesForRequestedTag(lanes: readonly LaneIdentity[], tag: string): LaneIdentity[] {
  return lanes.filter((lane) => {
    const legacy = lane.legacyTag ?? ""
    if (tag === "") return legacy === ""
    return legacy === tag || lane.name === tag
  })
}

/** True when `laneId` is one of the granted ids. */
export function laneTagAllowed(visible: VisibleLaneTags, laneId: string): boolean {
  if (visible === null) return true
  return visible.has(laneId)
}

/** Stable ETag / cache suffix. Empty when the caller is unrestricted. */
export function visibilityCacheToken(visible: VisibleLaneTags): string {
  if (visible === null) return ""
  const tags = [...visible].map((tag) => encodeURIComponent(tag)).sort()
  return `:vis:${tags.join(".")}`
}

/**
 * Display strings for the granted lanes: each lane's name, and its legacy
 * tag when that tag is non-empty. Ids are never returned. A lane named
 * "Yoruba Team" does not contribute the label "Yoruba".
 */
export function labelsForGrantedLanes(lanes: readonly LaneIdentity[], grantedIds: ReadonlySet<string>): Set<string> {
  const kept = new Set<string>()
  for (const lane of lanes) {
    if (!grantedIds.has(lane.id)) continue
    if (lane.name.trim() !== "") kept.add(lane.name)
    const legacy = lane.legacyTag ?? ""
    if (legacy !== "") kept.add(legacy)
  }
  return kept
}

/**
 * Drop lane labels the caller was not granted. `visible === null` returns the
 * response unchanged. `lanes` maps those ids to the names the UI shows.
 */
export function filterSettingsToVisibleLanes<T extends { settings: Record<string, unknown> }>(
  response: T,
  visible: VisibleLaneTags,
  lanes: readonly LaneIdentity[] = [],
): T {
  if (visible === null) return response
  const kept = labelsForGrantedLanes(lanes, visible)
  const settings: Record<string, unknown> = { ...response.settings }
  for (const key of ["targetLanes", "archivedLanes"] as const) {
    const value = settings[key]
    if (!Array.isArray(value)) continue
    settings[key] = value.filter((lane) => typeof lane === "string" && kept.has(lane))
  }
  const primary = settings.targetLanguage
  if (typeof primary === "string" && primary.trim() !== "" && !kept.has(primary)) {
    settings.targetLanguage = ""
  }
  return { ...response, settings }
}
