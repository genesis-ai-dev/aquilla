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
export const READ_WALL_MAINTAINER = 600

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
  if (input.role >= READ_WALL_MAINTAINER) return null
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
export function filterSettingsToVisibleLanes<
  T extends { settings: Record<string, unknown>; lanes?: readonly { id: string }[] },
>(
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
  const next = { ...response, settings }
  if (response.lanes) {
    next.lanes = response.lanes.filter((lane) => visible.has(lane.id))
  }
  return next
}

/**
 * Legacy tags (`''` for the default target lane) of the granted lane ids.
 * `null` means the caller is unrestricted. An empty set means no target lane.
 */
export function legacyTagsForVisibleLanes(
  lanes: readonly LaneIdentity[],
  visible: VisibleLaneTags,
): ReadonlySet<string> | null {
  if (visible === null) return null
  const tags = new Set<string>()
  for (const lane of lanes) {
    if (!visible.has(lane.id)) continue
    tags.add(lane.legacyTag ?? "")
  }
  return tags
}

export interface PortfolioLaneTotals {
  lane: string
  totalCells: number
  filledCells: number
  validatedCells: number
  lastEditAt: number | null
}

/**
 * Lane rows and text totals the caller may see. `null` when `allowedTags` is
 * null (unrestricted — the caller keeps the cross-lane SQL totals). Sums only
 * the lanes whose legacy tag is granted, so a hidden lane cannot contribute
 * a cell count or a newer edit time.
 */
export function portfolioTextFromVisibleLanes<T extends PortfolioLaneTotals>(
  lanes: readonly T[],
  allowedTags: ReadonlySet<string> | null,
): {
  lanes: T[]
  totalCells: number
  filledCells: number
  validatedCells: number
  lastEditAt: number | null
} | null {
  if (allowedTags === null) return null
  const kept = lanes.filter((lane) => allowedTags.has(lane.lane))
  let totalCells = 0
  let filledCells = 0
  let validatedCells = 0
  let lastEditAt: number | null = null
  for (const lane of kept) {
    totalCells += lane.totalCells
    filledCells += lane.filledCells
    validatedCells += lane.validatedCells
    if (lane.lastEditAt != null && Number.isFinite(lane.lastEditAt)) {
      lastEditAt = lastEditAt == null ? lane.lastEditAt : Math.max(lastEditAt, lane.lastEditAt)
    }
  }
  return { lanes: kept, totalCells, filledCells, validatedCells, lastEditAt }
}

/**
 * The portfolio's `targetLanguage` is the default lane's name. Hide it unless
 * that lane (`legacy_tag ''`) is visible. `null` allowedTags keeps it.
 */
export function visibleDefaultLaneLanguage(
  targetLanguage: string | null,
  allowedTags: ReadonlySet<string> | null,
): string | null {
  if (allowedTags === null) return targetLanguage
  return allowedTags.has("") ? targetLanguage : null
}
