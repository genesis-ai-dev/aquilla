// AQU-1808 — the sharer's lane choice, before it becomes a request body.
//
// Below maintainer, a missing choice is not "every lane". The server
// rejects that for a role below project lead. A project lead is asked too:
// they see only the lanes they are granted. Maintainer and above are not
// asked.
//
// AQU-2358 — choosing NO lanes is now one of the answers. It is a complete
// choice (`laneChoiceReady`), it travels as the reserved `NO_LANE_SCOPE`
// value, and because it is easy to make by accident the surfaces ask for a
// confirmation first: `grantsNoLanes` is what they gate that on.

import { ROLE } from "@/lib/frontier/roles"
import { NO_LANE_SCOPE } from "@/lib/lanes/no-lane-access"

export type LaneAccessChoice =
  | { kind: "all" }
  | { kind: "lanes"; laneIds: string[] }

/** Fields merged into a membership or invite body. */
export type MemberLaneAccess = { allCurrentLanes: true } | { scopeLanes: string[] }

export function needsLaneChoice(roleLevel: number, laneCount: number): boolean {
  return roleLevel < ROLE.MAINTAINER && laneCount > 0
}

/**
 * AQU-2358: a one-lane project pre-checks its only lane, so the common case
 * needs no decision and the warning below is never hit by accident. With more
 * than one lane nothing is pre-selected — guessing which lanes someone should
 * read is how the silent every-lane default went wrong.
 */
export function initialLaneChoice(
  lanes: readonly { id: string }[],
  roleLevel: number,
): LaneAccessChoice | null {
  if (!needsLaneChoice(roleLevel, lanes.length)) return null
  if (lanes.length !== 1) return null
  return { kind: "lanes", laneIds: [lanes[0]!.id] }
}

export function laneChoiceReady(
  choice: LaneAccessChoice | null,
  roleLevel: number,
  laneCount: number,
): boolean {
  if (!needsLaneChoice(roleLevel, laneCount)) return true
  // AQU-2358: an empty lane list is an answer ("no lanes"), not a blank form.
  // Only having said nothing at all blocks the submit.
  return choice !== null
}

/**
 * AQU-2358: whether this choice grants no lanes, so the surface asks the
 * sharer to confirm before saving. False when no choice has been made yet —
 * that is "not ready", not "none", and `laneChoiceReady` owns it.
 */
export function grantsNoLanes(
  choice: LaneAccessChoice | null,
  roleLevel: number,
  laneCount: number,
): boolean {
  if (!needsLaneChoice(roleLevel, laneCount)) return false
  if (!choice || choice.kind !== "lanes") return false
  return choice.laneIds.length === 0
}

/** Grant-sentence lanes for the choice currently on the form. */
export function chosenLaneLabels(
  lanes: readonly { id: string; label: string }[],
  roleLevel: number,
  choice: LaneAccessChoice | null,
): "all" | "none" | "unknown" | string[] {
  if (!needsLaneChoice(roleLevel, lanes.length)) return "all"
  if (!choice) return "unknown"
  if (choice.kind === "all") return "all"
  // AQU-2358: an empty selection reads as "no language lanes", never as the
  // every-lane fallback an empty label list used to land on.
  if (choice.laneIds.length === 0) return "none"
  return lanes.filter((lane) => choice.laneIds.includes(lane.id)).map((lane) => lane.label)
}

export function toMemberLaneAccess(choice: LaneAccessChoice): MemberLaneAccess {
  if (choice.kind === "all") return { allCurrentLanes: true }
  // AQU-2358: the reserved value is how "no lanes" reaches the server; an
  // empty `scopeLanes` is indistinguishable from omitting the field.
  if (choice.laneIds.length === 0) return { scopeLanes: [NO_LANE_SCOPE] }
  return { scopeLanes: choice.laneIds }
}
