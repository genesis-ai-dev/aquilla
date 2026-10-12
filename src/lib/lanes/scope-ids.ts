/**
 * AQU-1607: a lane scope is a lane id.
 *
 * `project_member_scopes` rows with `kind = 'lane'` and the lane list on
 * `project_invites.scope_lanes` used to hold a target-language TAG — the
 * language string, with `''` standing for the default lane. A tag cannot tell
 * two lanes of the same language apart, so scoping someone to one of them
 * scoped them to both (or, where the code refused to guess, to neither).
 * Both now store `lanes.id`.
 *
 * Writers convert at the API boundary (`resolveLaneScopeValue`): a lane id is
 * kept, and a legacy tag that names exactly one lane becomes that lane's id,
 * so an older client that still sends `''` keeps working and the row it
 * writes is already an id. Zero or two matches is refused, never guessed.
 *
 * Readers and enforcement go through `laneScopeAdmitsTag`, which accepts a
 * stored value either way: an id matches the lane with that id, and a value
 * that is no lane's id is compared to the event's tag exactly as before. That
 * fallback is what lets this land ahead of the batch backfill (AQU-1616) that
 * converts the rows already in the database; it goes away with the backfill's
 * fallback-removal pass.
 */

import { lanesForRequestedTag, type LaneIdentity } from "./read-wall"

/** Why a caller-supplied lane scope could not be stored as a lane id. */
export type LaneScopeProblem = "unmatched" | "ambiguous"

export type LaneScopeResolution =
  | { ok: true; laneId: string }
  | { ok: false; reason: LaneScopeProblem }

/**
 * The lane id a caller-supplied scope value names. A value that is one of
 * `lanes`' ids resolves to itself; anything else is read as a legacy tag (or
 * a lane name — `lanesForRequestedTag`'s rule) and must name exactly one lane.
 */
export function resolveLaneScopeValue(
  value: string,
  lanes: readonly LaneIdentity[],
): LaneScopeResolution {
  if (lanes.some((lane) => lane.id === value)) return { ok: true, laneId: value }
  const matches = lanesForRequestedTag(lanes, value)
  if (matches.length === 1) return { ok: true, laneId: matches[0]!.id }
  return { ok: false, reason: matches.length === 0 ? "unmatched" : "ambiguous" }
}

export interface LaneScopeConversion {
  /** Lane ids, de-duped, in the order their first source value appeared. */
  laneIds: string[]
  /** Values that named no lane, or two. Stored as-is nowhere — they refuse. */
  rejected: Array<{ value: string; reason: LaneScopeProblem }>
}

/**
 * Convert a caller's lane scope list to lane ids for storage. Nothing is
 * dropped silently: every value either contributes an id or appears in
 * `rejected`, so a route can answer with the ones it could not place.
 */
export function laneScopeIdsForStorage(
  values: readonly string[],
  lanes: readonly LaneIdentity[],
): LaneScopeConversion {
  const laneIds: string[] = []
  const seen = new Set<string>()
  const rejected: LaneScopeConversion["rejected"] = []
  for (const value of values) {
    const resolved = resolveLaneScopeValue(value, lanes)
    if (!resolved.ok) {
      rejected.push({ value, reason: resolved.reason })
      continue
    }
    if (seen.has(resolved.laneId)) continue
    seen.add(resolved.laneId)
    laneIds.push(resolved.laneId)
  }
  return { laneIds, rejected }
}

/**
 * The lane ids a set of STORED scope values stands for. Values that are not
 * lane ids are resolved as legacy tags where they name exactly one lane; a
 * tag that names zero or two lanes contributes no id and stays in
 * `legacyTags`, where `laneScopeAdmitsTag` still compares it literally.
 */
export function laneScopeIds(
  values: readonly string[],
  lanes: readonly LaneIdentity[],
): { ids: Set<string>; legacyTags: Set<string> } {
  const ids = new Set<string>()
  const legacyTags = new Set<string>()
  for (const value of values) {
    if (lanes.some((lane) => lane.id === value)) {
      ids.add(value)
      continue
    }
    const matches = lanesForRequestedTag(lanes, value)
    if (matches.length === 1) ids.add(matches[0]!.id)
    else legacyTags.add(value)
  }
  return { ids, legacyTags }
}

/**
 * Whether stored lane scopes admit the lane an event names by its tag.
 *
 * `tag` is `payload.targetLang` (`''` is the default lane). The tag resolves
 * through the project's lane rows, so an id scope admits exactly its own lane
 * even when another lane shares the language. Where two lanes answer to the
 * same tag the event itself has not said which it means, so a scope naming
 * either of them admits it — the same answer the tag comparison gave before,
 * and no wider. A scope value that is neither an id nor a single-lane tag —
 * an unconverted row in a project whose lanes are ambiguous, or any value in
 * a caller that has no lane rows to hand — is compared to the tag literally,
 * which is the pre-AQU-1607 rule.
 */
export function laneScopeAdmitsTag(
  values: readonly string[],
  lanes: readonly LaneIdentity[],
  tag: string,
): boolean {
  const { ids, legacyTags } = laneScopeIds(values, lanes)
  if (legacyTags.has(tag)) return true
  if (ids.size === 0) return false
  const matches = lanesForRequestedTag(lanes, tag)
  return matches.some((lane) => ids.has(lane.id))
}

/**
 * The legacy tags a set of stored scope values stands for — what a surface
 * that still speaks tags (the lane switcher, the editor's lane list) can
 * compare against. A value that resolves to no lane keeps its own text so a
 * stale scope still reads the same as it did.
 */
export function laneScopeTags(
  values: readonly string[],
  lanes: readonly LaneIdentity[],
): Set<string> {
  const { ids, legacyTags } = laneScopeIds(values, lanes)
  const tags = new Set<string>(legacyTags)
  for (const lane of lanes) {
    if (ids.has(lane.id)) tags.add(lane.legacyTag ?? "")
  }
  return tags
}

/**
 * Stored lane scopes rewritten to the legacy tags a tag-speaking surface
 * compares against — the client's affordance layer, whose active lane is
 * still a tag (`isInMemberScope`, the lane switcher). A value that resolves
 * to a lane becomes that lane's tag; one that resolves to none keeps its own
 * text, so a stale scope reads exactly as it did.
 *
 * Two lanes can share a tag, so this is deliberately lossy and is only ever
 * used to decide what to offer. The server resolves by lane id and remains
 * the authority on every write.
 */
export function laneScopesAsTags<T extends { kind: string; value: string }>(
  scopes: readonly T[],
  lanes: readonly LaneIdentity[],
): T[] {
  if (lanes.length === 0) return [...scopes]
  return scopes.map((scope) => {
    if (scope.kind !== "lane") return scope
    const lane = lanes.find((row) => row.id === scope.value)
    return lane ? { ...scope, value: lane.legacyTag ?? "" } : scope
  })
}

/**
 * What a settings response should keep for a member limited to these lane
 * scopes. `visible` is the set `filterSettingsToVisibleLanes` tests membership
 * against. With lane rows, that set is lane ids. With none yet — a project
 * the lane backfill has not given rows — each stored value is the tag itself,
 * so the synthetic identity uses that value as id, name, and legacy tag.
 * Does not read `lanes.language`.
 */
export function lanesForScopeVisibility(
  values: readonly string[],
  lanes: readonly LaneIdentity[],
): { visible: ReadonlySet<string>; lanes: readonly LaneIdentity[] } {
  if (lanes.length === 0) {
    const synthetic = values.map((value) => ({ id: value, name: value, legacyTag: value }))
    return { visible: new Set(values), lanes: synthetic }
  }
  return { visible: laneScopeIds(values, lanes).ids, lanes }
}
