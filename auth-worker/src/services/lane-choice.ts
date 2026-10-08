// AQU-1808 — adding someone below project lead has to say which lanes.
//
// Omitting the lane list used to mean "every current target lane". That
// silent default is what left a contributor looking at an empty file when
// the grants and the sharer's intent disagreed. The sharer now sends one
// of two explicit choices:
//
//   allCurrentLanes: true   — no lane scopes; grants on every current lane
//   scopeLanes: [ids]       — those lanes only, at the project role
//
// A project lead and above are not lane-scoped. Their role already sees
// every lane (and a lead below the old Maintainer wall still receives a
// grant on each current lane from the existing planner). A role change of
// someone who is already a member does not ask again: the lanes they hold
// stay, and only the level is rewritten.

import { ROLE, type Env } from "../types"
import { loadCurrentTargetLanes } from "../../../db/shared/lane-visibility"
import { resolveInviteLaneScopes } from "./invite-scopes"

export const LANE_CHOICE_REQUIRED = "lane_choice_required"
export const LANE_CHOICE_CONFLICT = "lane_choice_conflict"

export type ExplicitLaneChoice =
  | { ok: true; kind: "skip" | "all" }
  | { ok: true; kind: "lanes"; laneIds: string[] }
  | {
      ok: false
      code: string
      error: string
      ambiguous?: string[]
      unmatched?: string[]
    }

export async function resolveExplicitLaneChoice(
  env: Pick<Env, "AQUILLA_PG">,
  projectIds: readonly string[],
  input: {
    role: number
    allCurrentLanes?: boolean
    scopeLanes?: readonly string[]
    /** False when this person is already a direct member and only the role is changing. */
    requireChoice: boolean
  },
): Promise<ExplicitLaneChoice> {
  if (input.role >= ROLE.PROJECT_LEAD) return { ok: true, kind: "skip" }

  const requested = input.scopeLanes ?? []
  const wantsAll = input.allCurrentLanes === true
  if (wantsAll && requested.length > 0) {
    return {
      ok: false,
      code: LANE_CHOICE_CONFLICT,
      error: "Choose every current target lane or name specific lanes, not both.",
    }
  }
  if (requested.length > 0) {
    const resolved = await resolveInviteLaneScopes(env, projectIds, requested)
    if (!resolved.ok) {
      return {
        ok: false,
        code: "lane_unresolved",
        error:
          projectIds.length > 1
            ? "scopeLanes must each name one lane of these projects"
            : "scopeLanes must each name one lane of this project",
        ...(resolved.ambiguous.length > 0 ? { ambiguous: resolved.ambiguous } : {}),
        ...(resolved.unmatched.length > 0 ? { unmatched: resolved.unmatched } : {}),
      }
    }
    return { ok: true, kind: "lanes", laneIds: resolved.laneIds }
  }
  if (wantsAll) return { ok: true, kind: "all" }
  if (!input.requireChoice) return { ok: true, kind: "skip" }

  for (const projectId of projectIds) {
    const current = await loadCurrentTargetLanes(env.AQUILLA_PG, projectId)
    if (current.length > 0) {
      return {
        ok: false,
        code: LANE_CHOICE_REQUIRED,
        error: "Choose the target lanes for this person, or choose every current target lane.",
      }
    }
  }
  return { ok: true, kind: "skip" }
}
