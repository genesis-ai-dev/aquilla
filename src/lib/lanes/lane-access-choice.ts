// AQU-1808 — the sharer's lane choice, before it becomes a request body.
//
// Below project lead, a missing choice is not "every lane". The server
// rejects that. Project lead and above are not asked: they see every lane
// and are not given lane scopes.

import { ROLE } from "@/lib/frontier/roles"

export type LaneAccessChoice =
  | { kind: "all" }
  | { kind: "lanes"; laneIds: string[] }

/** Fields merged into a membership or invite body. */
export type MemberLaneAccess = { allCurrentLanes: true } | { scopeLanes: string[] }

export function needsLaneChoice(roleLevel: number, laneCount: number): boolean {
  return roleLevel < ROLE.PROJECT_LEAD && laneCount > 0
}

export function laneChoiceReady(
  choice: LaneAccessChoice | null,
  roleLevel: number,
  laneCount: number,
): boolean {
  if (!needsLaneChoice(roleLevel, laneCount)) return true
  if (!choice) return false
  if (choice.kind === "all") return true
  return choice.laneIds.length > 0
}

/** Grant-sentence lanes for the choice currently on the form. */
export function chosenLaneLabels(
  lanes: readonly { id: string; label: string }[],
  roleLevel: number,
  choice: LaneAccessChoice | null,
): "all" | "unknown" | string[] {
  if (!needsLaneChoice(roleLevel, lanes.length)) return "all"
  if (!choice) return "unknown"
  if (choice.kind === "all") return "all"
  return lanes.filter((lane) => choice.laneIds.includes(lane.id)).map((lane) => lane.label)
}

export function toMemberLaneAccess(choice: LaneAccessChoice): MemberLaneAccess {
  if (choice.kind === "all") return { allCurrentLanes: true }
  return { scopeLanes: choice.laneIds }
}
