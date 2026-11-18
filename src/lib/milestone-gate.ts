// AQU-2309: who is offered the milestone actions — set, rename, resize, remove.
//
// One answer for the cell menu and the chapter navigator, so they cannot
// drift. The Media timeline asks the same question when it lands.
//
// The role-policy row is only the static floor (project lead, the lowest
// rung the setting can admit). The project's own tier — `milestoneFloor`,
// maintainer unless set otherwise — is applied here, and again on the
// events route, so a stale page cannot write past a raised setting.
//
// Below the floor the actions are absent, not disabled. A live-linked
// downstream shows them to nobody, whatever the tier says: its divisions
// are mirrored from upstream.

import { milestoneFloorLevel } from "../../db/shared/milestone-floor"
import { canPerform } from "@/lib/sync/role-policy"

export interface MilestoneGateSubject {
  /**
   * The viewer's level on this project. Null or undefined is a local project,
   * or a role the client has not heard yet: `canPerform` fails open there,
   * and the server still refuses a cloud write below the floor.
   */
  roleLevel: number | null | undefined
  /** The project's tier, as the record carries it (`milestoneFloor`). */
  milestoneFloor?: unknown
  /** `"live"` is a downstream mirroring another's source. */
  sourceLinkMode?: "clone" | "live" | null
}

/**
 * May this person set, rename, resize or remove a milestone on this project?
 *
 * A known role below the floor is refused. An unknown role is not: that is
 * the editor's fail-open contract for a project with no membership row.
 */
export function canSetMilestones(subject: MilestoneGateSubject): boolean {
  if (subject.sourceLinkMode === "live") return false
  const level = subject.roleLevel
  if (level == null) return true
  if (!canPerform("file.milestone.set", level)) return false
  return level >= milestoneFloorLevel(subject.milestoneFloor)
}
