/**
 * AQU-1415 write wall — pure deny rules.
 *
 * The wall is on when `LANE_READ_WALL` is "1" or "true", the same switch as
 * the read wall. Off means today's additive `scopes` claim still decides.
 * On means a below-Maintainer write to a target lane needs a `laneGrants`
 * row whose `lane` is `lanes.id`. No grant means no write.
 *
 * The event still names a language tag (`targetLang` / legacy tag). That tag
 * must resolve to exactly one target lane by `legacy_tag` or `name`. Zero
 * matches and two matches both deny: a language string must not open two lanes.
 */

import { laneReadWallEnabled, lanesForRequestedTag, type LaneGrant, type LaneIdentity } from "./read-wall"

/** Viewer. A grant below this does not reveal a lane. */
const VIEWER = 100
/** Maintainer. At and above this role, lane grants are not required. */
export const WRITE_WALL_MAINTAINER = 600

export type LaneWriteDecision =
  | { action: "skip" }
  | { action: "allow"; effectiveRole: number }
  | { action: "deny"; reason: string }

/**
 * `max(project role, grant level)`. A grant only elevates. `null` when the
 * caller has no revealing grant for this lane.
 */
export function effectiveRoleInLane(projectRole: number, grantLevel: number | null): number | null {
  if (grantLevel == null) return null
  return Math.max(projectRole, grantLevel)
}

/** Highest revealing grant level for `laneId`, or null when none qualifies. */
export function revealingGrantLevel(
  grants: readonly LaneGrant[] | null | undefined,
  laneId: string,
): number | null {
  let best: number | null = null
  for (const grant of grants ?? []) {
    if (grant.lane !== laneId) continue
    if (typeof grant.level !== "number" || grant.level < VIEWER) continue
    if (best == null || grant.level > best) best = grant.level
  }
  return best
}

/**
 * Whether this caller may write the lane `laneTag` names.
 * `skip` means the caller is unrestricted (wall off, platform, or Maintainer+);
 * the existing role floor still applies.
 */
export function decideLaneWrite(input: {
  enabled: boolean
  role: number
  src?: string
  laneGrants?: readonly LaneGrant[] | null
  laneTag: string
  lanes: readonly LaneIdentity[]
  requiredRole: number
}): LaneWriteDecision {
  if (!input.enabled) return { action: "skip" }
  if (input.src === "platform") return { action: "skip" }
  if (input.role >= WRITE_WALL_MAINTAINER) return { action: "skip" }

  const matches = lanesForRequestedTag(input.lanes, input.laneTag)
  if (matches.length !== 1) {
    return {
      action: "deny",
      reason: `lane '${input.laneTag}' does not resolve to one target lane`,
    }
  }
  const laneId = matches[0]!.id
  const grantLevel = revealingGrantLevel(input.laneGrants, laneId)
  const effective = effectiveRoleInLane(input.role, grantLevel)
  if (effective == null) {
    return { action: "deny", reason: `no lane grant for '${input.laneTag}'` }
  }
  if (effective < input.requiredRole) {
    return {
      action: "deny",
      reason: `role too low for lane '${input.laneTag}'`,
    }
  }
  return { action: "allow", effectiveRole: effective }
}

export { laneReadWallEnabled }
