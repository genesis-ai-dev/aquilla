// AQU-1808 — adding someone below project lead has to say which lanes.
//
// Omitting the lane list used to mean "every current target lane". That
// silent default is what left a contributor looking at an empty file when
// the grants and the sharer's intent disagreed. The sharer now sends one
// of two explicit choices:
//
//   allCurrentLanes: true   — below project lead: no lane scopes; grants on
//                             every current lane, and a later lane too
//   scopeLanes: [ids]       — those lanes only
//
// Maintainer and above are not lane-scoped. A project lead is: a fresh
// membership that does not name lanes is a snapshot of the lanes that exist
// then (kind "snapshot"), and a named list is those lanes only. A role
// change of someone who is already a member does not ask again: the lanes
// they hold stay, and only the level is rewritten. Raising someone to
// project lead does not reveal a lane. A choice that IS named on the add of
// an existing member replaces their lanes, and a fresh membership starts from
// no lane rows — the rows of a removed membership are not inherited.
//
// AQU-2358 adds a third answer: the reserved `NO_LANE_SCOPE` value, alone in
// `scopeLanes`, means NO lanes. It is stored as that one scope value rather
// than as zero rows, because zero rows is how "every current lane" is already
// stored; see src/lib/lanes/no-lane-access.ts. It applies at every role below
// maintainer, a project lead included — an explicit choice is never replaced
// by the lane snapshot — and mixing it with real lanes or with
// `allCurrentLanes` is refused rather than guessed at.

import { ROLE, type Env } from "../types"
import { loadCurrentTargetLanes } from "../../../db/shared/lane-visibility"
import { NO_LANE_SCOPE, grantsNoLaneScopes } from "../../../src/lib/lanes/no-lane-access"
import { resolveInviteLaneScopes } from "./invite-scopes"

export const LANE_CHOICE_REQUIRED = "lane_choice_required"
export const LANE_CHOICE_CONFLICT = "lane_choice_conflict"

export type ExplicitLaneChoice =
  | { ok: true; kind: "skip" | "all" | "snapshot" }
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
  const requested = input.scopeLanes ?? []
  const wantsAll = input.allCurrentLanes === true
  // AQU-2358: "no lanes" is a whole answer, so it travels alone.
  const noLanes = grantsNoLaneScopes(requested)
  if (noLanes && (wantsAll || requested.length > 1)) {
    return {
      ok: false,
      code: LANE_CHOICE_CONFLICT,
      error: "Choose no lanes, every current target lane, or specific lanes — not a mixture.",
    }
  }
  if (input.role >= ROLE.MAINTAINER) return { ok: true, kind: "skip" }
  // Below maintainer every role honours it, a project lead included: an
  // explicit choice is never overwritten by the lead snapshot below.
  if (noLanes) return { ok: true, kind: "lanes", laneIds: [NO_LANE_SCOPE] }
  if (input.role >= ROLE.PROJECT_LEAD) {
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
    // A role change keeps the lanes they already hold. A fresh project lead
    // is snapshotted onto the lanes that exist then.
    if (!input.requireChoice) return { ok: true, kind: "skip" }
    return { ok: true, kind: "snapshot" }
  }

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
