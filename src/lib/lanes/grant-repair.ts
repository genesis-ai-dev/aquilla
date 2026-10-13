/**
 * AQU-1786 — which missing lane grants the repair may insert.
 *
 * DB-free. The script loads one project's target lanes, each member's role,
 * their kind='lane' scopes, and the grants they already hold, then calls
 * planGrantRepair.
 *
 * An unscoped member (no lane scopes) below Maintainer and at or above Viewer
 * gets a grant on every current, non-archived target lane they do not already
 * hold, at their project role level. A member with any lane scope is left
 * untouched, including lanes they were never granted. Archived lanes are
 * never granted. Nothing here deletes or rewrites an existing grant: a second
 * plan, after the inserts are treated as already held, is empty.
 */

/** Project role at which the read wall stops. Stays 600 on this branch: AQU-1795's lead floor is not merged. */
const MAINTAINER = 600
const VIEWER = 100

export interface GrantRepairLane {
  id: string
  name: string
  archived: boolean
}

export interface GrantRepairMember {
  userId: string
  roleLevel: number
  /** True for a platform operator. They see every lane and get no rows. */
  platform?: boolean
  /** kind='lane' scope values. Any value means this member is left untouched. */
  laneScopes: readonly string[]
  /** Lane ids they already hold a grant on. */
  grantLaneIds: readonly string[]
}

export interface GrantRepairInsert {
  userId: string
  laneId: string
  laneName: string
  level: number
  /**
   * How many current target lanes this member already held. Zero means they
   * saw no target lane. A positive count means the repair fills lanes an
   * unscoped member is missing, which a reviewer should read before apply.
   */
  priorGrantCount: number
}

export interface GrantRepairPlan {
  inserts: GrantRepairInsert[]
  /** Always empty. The repair never deletes a grant. */
  deletions: readonly never[]
  scopedMembersUntouched: number
  skippedMaintainer: number
  skippedBelowViewer: number
  skippedPlatform: number
  skippedArchivedLanes: number
  alreadyPresent: number
}

export function planGrantRepair(input: {
  members: readonly GrantRepairMember[]
  lanes: readonly GrantRepairLane[]
}): GrantRepairPlan {
  const active = input.lanes.filter((lane) => !lane.archived)
  const inserts: GrantRepairInsert[] = []
  let scopedMembersUntouched = 0
  let skippedMaintainer = 0
  let skippedBelowViewer = 0
  let skippedPlatform = 0
  let alreadyPresent = 0

  for (const member of input.members) {
    if (member.platform) {
      skippedPlatform++
      continue
    }
    if (member.roleLevel >= MAINTAINER) {
      skippedMaintainer++
      continue
    }
    if (member.roleLevel < VIEWER) {
      skippedBelowViewer++
      continue
    }
    if (member.laneScopes.length > 0) {
      scopedMembersUntouched++
      continue
    }
    const held = new Set(member.grantLaneIds)
    const priorGrantCount = active.filter((lane) => held.has(lane.id)).length
    for (const lane of active) {
      if (held.has(lane.id)) {
        alreadyPresent++
        continue
      }
      inserts.push({
        userId: member.userId,
        laneId: lane.id,
        laneName: lane.name,
        level: member.roleLevel,
        priorGrantCount,
      })
    }
  }

  return {
    inserts,
    deletions: [],
    scopedMembersUntouched,
    skippedMaintainer,
    skippedBelowViewer,
    skippedPlatform,
    skippedArchivedLanes: input.lanes.length - active.length,
    alreadyPresent,
  }
}
