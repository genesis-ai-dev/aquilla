/**
 * AQU-1783 — what the member inspector may truthfully say about one member's
 * lane access.
 *
 * The inspector used to read `project_member_scopes` and print "Unscoped —
 * full access" whenever it was empty. The read wall reads a different table,
 * `project_member_lane_roles` (the grants). The two drift apart whenever
 * grants were never written or lag behind the lane set — a lane created after
 * the member joined, a member added directly rather than by invite. A lead
 * then saw "full access" for someone who in fact read none of the project's
 * target lanes, with nothing on screen to diagnose it.
 *
 * So this answers the question from the grants, not the scopes, and it answers
 * it with the SAME rule the wall enforces: `visibleLaneTags` decides, so the
 * inspector cannot claim access the wall denies (a grant below Viewer reveals
 * no lane; Maintainer and above see every lane through their role).
 *
 * DB-free, so both the worker (which assembles the payload) and the editor
 * (which renders it) agree on the verdict.
 */

import { visibleLaneTags, type LaneGrant } from "./read-wall"

/** One grant row as the inspector endpoint reports it. */
export interface MemberLaneGrant {
  laneId: string
  /** The lane's display name at read time — never its id. */
  name: string
  level: number
}

/** A current (non-archived) target lane of the project. */
export interface CurrentTargetLane {
  id: string
  name: string
}

/** One row of the inspector's "lanes they can read" list. */
export interface LaneAccessRow {
  laneId: string
  name: string
  granted: boolean
}

export type MemberLaneAccessVerdict =
  /**
   * Every lane is readable and no grant list is meaningful. `reason` is
   * `"role"` when the member is Maintainer or above (the inspector says so),
   * or `"wall-off"` in an environment where `LANE_READ_WALL` is unset — local
   * and e2e — where grants gate nothing and a gap warning would be a false
   * alarm.
   */
  | { kind: "unrestricted"; reason: "role" | "wall-off" }
  /**
   * The member reads only the granted lanes. `lanes` is every current target
   * lane, each flagged; `missing` is the subset they cannot read.
   *
   * `gap` is `missing.length > 0`. `warn` narrows that to the case the issue
   * is about: an UNSCOPED member missing a lane, which is a gap rather than a
   * deliberate restriction — a member deliberately scoped to one lane of
   * three is missing two by design and gets no warning.
   */
  | {
      kind: "restricted"
      lanes: LaneAccessRow[]
      missing: LaneAccessRow[]
      gap: boolean
      warn: boolean
      coversAll: boolean
      unscoped: boolean
    }

export interface MemberLaneAccessInput {
  /** The member's EFFECTIVE project role, the one the wall resolves. */
  memberRoleLevel: number
  grants: readonly MemberLaneGrant[]
  /** Current, non-archived target lanes, in display order. */
  targetLanes: readonly CurrentTargetLane[]
  /** How many `kind: 'lane'` scopes the member has. 0 = unscoped. */
  laneScopeCount: number
  /**
   * Whether the serving environment enforces the wall (`laneReadWallEnabled`
   * of its `LANE_READ_WALL`). The worker resolves the flag and puts the answer
   * on the wire, because only it can see the binding.
   */
  readWallEnabled: boolean
}

export function memberLaneAccess(input: MemberLaneAccessInput): MemberLaneAccessVerdict {
  if (!input.readWallEnabled) return { kind: "unrestricted", reason: "wall-off" }
  const laneGrants: LaneGrant[] = input.grants.map((grant) => ({ lane: grant.laneId, level: grant.level }))
  const visible = visibleLaneTags({ enabled: true, role: input.memberRoleLevel, laneGrants })
  // Only the Maintainer+ cascade can reach here, the wall flag being on.
  if (visible === null) return { kind: "unrestricted", reason: "role" }
  const lanes: LaneAccessRow[] = input.targetLanes.map((lane) => ({
    laneId: lane.id,
    name: lane.name,
    granted: visible.has(lane.id),
  }))
  const missing = lanes.filter((lane) => !lane.granted)
  const unscoped = input.laneScopeCount === 0
  return {
    kind: "restricted",
    lanes,
    missing,
    gap: missing.length > 0,
    warn: unscoped && missing.length > 0,
    coversAll: missing.length === 0,
    unscoped,
  }
}
