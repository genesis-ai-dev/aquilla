// AQU-528: language-scoped invite links (Crowdin-style auto-grant-on-join).
//
// A share-link invite may carry an optional set of lane (target-language)
// scopes. When such a link is redeemed by a *new* project member, the accept
// handler auto-applies those lanes as kind='lane' rows in project_member_scopes
// (the same additive write-restriction primitive from AQU-553 / migration
// 0059), so the joiner can only translate the languages the link was minted
// for. Enforcement, sync-token embedding, and sync-worker gating already exist
// and need no change — this module only owns the invite side of the seam.
//
// Storage: a JSON-encoded string[] on project_invites.scope_lanes. AQU-1607:
// a lane value is a `lanes.id`. Invite routes convert what the caller sent
// (an id, or a legacy language tag that names exactly one lane) before
// storing, so nothing written from here on is a tag and no new `''` appears.
// Rows minted before that — and before the AQU-1616 backfill converts them —
// still hold tags, so the apply path below resolves either shape.

import { ROLE } from "../types"
import type { Env } from "../types"
import { planLaneGrants } from "../../../src/lib/lanes/grant-backfill"
import { laneScopeIdsForStorage, resolveLaneScopeValue } from "../../../src/lib/lanes/scope-ids"
import {
  loadTargetLaneIdentities,
  loadTargetLaneIdentitiesForProjects,
} from "../../../db/shared/lane-visibility"
import type { LaneIdentity } from "../../../src/lib/lanes/read-wall"

/** Max distinct lanes a single invite may carry (defensive bound). */
export const MAX_INVITE_SCOPE_LANES = 50
/** Max length of a single lane (target-language) value. */
export const MAX_LANE_VALUE_LENGTH = 64

/**
 * Normalize a caller-supplied lane list for storage: trim to the bound,
 * de-dupe (order-preserving). Returns a JSON string, or null when there are no
 * lanes (an unscoped invite). `undefined`/empty both serialize to null so an
 * omitted field and an explicit `[]` behave identically (= unscoped).
 */
export function serializeScopeLanes(
  lanes: readonly string[] | undefined,
): string | null {
  if (!lanes || lanes.length === 0) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lanes) {
    // '' is the valid default lane — keep it; only collapse dupes.
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
    if (out.length >= MAX_INVITE_SCOPE_LANES) break
  }
  return out.length > 0 ? JSON.stringify(out) : null
}

/**
 * Parse the stored scope_lanes column back into a lane list. Tolerant of
 * null/garbage (a corrupt value must never blow up an accept): anything that
 * isn't a JSON array of strings yields [] (= unscoped, today's behavior).
 */
export function parseScopeLanes(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    return []
  }
}

/**
 * Apply an invite's lane scopes to a member on accept.
 *
 * AQU-1808: the invite's choice is the whole truth about the joiner's lanes.
 * Removing a member deletes only `project_members`, so the scope and grant
 * rows of an earlier membership survive; unioned into them, an every-lane
 * link used to leave a stale one-lane scope that the client narrowed by, and
 * a one-lane link used to keep an earlier every-lane grant set. Both tables
 * are cleared for this (project, user) first, so the membership this accept
 * creates starts from no lane rows.
 *
 * Callers must only invoke this for a *newly inserted* membership: applying a
 * lane scope to an existing unscoped member would silently narrow their access
 * from all-lanes to one lane, which the "new user signs up via link" flow never
 * intends. `finalRole` is guarded here too — a joiner resolving to
 * project_lead+ must stay unscoped per the AD-12 invariant (member-scopes CRUD
 * rejects scoping leads), so lanes are skipped in that case.
 */
export async function applyInviteLaneScopes(
  env: Env,
  projectId: string,
  userId: number,
  lanes: readonly string[],
  createdBy: number,
  finalRole: number,
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "DELETE FROM project_member_scopes WHERE project_id = ? AND user_id = ? AND kind = 'lane'",
  )
    .bind(projectId, userId)
    .run()
  await env.AQUILLA_PG.prepare(
    "DELETE FROM project_member_lane_roles WHERE project_id = ? AND user_id = ?",
  )
    .bind(projectId, userId)
    .run()
  if (finalRole >= ROLE.MAINTAINER || finalRole < ROLE.VIEWER) return

  // Project lead+ stays unscoped on the old scopes table (AD-12). An empty
  // lane list is an unscoped invite. Both still need a grant per current
  // target lane, or the write wall treats "no rows" as "no access".
  const restrictive = finalRole < ROLE.PROJECT_LEAD && lanes.length > 0

  // AQU-1607: both tables key the lane by id. One resolution for both, so a
  // scope row and its grant can never disagree about which lane was meant.
  //
  // A multi-project link carries one lane list for every project it covers,
  // so most of its ids belong to a sibling project here. Those are dropped.
  // When NOTHING resolves — a stale id, a tag that names two lanes — the raw
  // values are stored instead of nothing at all: a scope nobody's lane
  // matches lets the joiner write in no lane, which is what an unresolvable
  // scope did before this ticket. Storing no rows would instead read as
  // "unscoped" and hand them every lane.
  const identities = await loadTargetLaneIdentities(env.AQUILLA_PG, projectId)
  const resolved = restrictive ? laneScopeIdsForStorage(lanes, identities).laneIds : []
  const laneIds = restrictive && resolved.length === 0 ? [...lanes] : resolved

  if (restrictive) {
    const now = Date.now()
    for (const laneId of laneIds) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_scopes
           (project_id, user_id, kind, value, created_by, created_at)
         VALUES (?, ?, 'lane', ?, ?, ?)
         ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
      )
        .bind(projectId, userId, laneId, String(createdBy), now)
        .run()
    }
  }

  // AQU-1415: the write wall reads laneGrants (lanes.id). An empty list
  // grants every current lane.
  await applyInviteLaneGrants(env, projectId, userId, laneIds, createdBy, finalRole, identities)
}

async function applyInviteLaneGrants(
  env: Env,
  projectId: string,
  userId: number,
  lanes: readonly string[],
  createdBy: number,
  finalRole: number,
  identities: readonly LaneIdentity[],
): Promise<void> {
  const plan = planLaneGrants({
    roleLevel: finalRole,
    laneScopes: lanes,
    lanes: identities,
  })
  for (const grant of plan.grants) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles
         (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
      .bind(projectId, userId, grant.laneId, grant.level, createdBy)
      .run()
  }
}

/**
 * AQU-1607: the lane ids an invite should store for what the caller asked
 * for. A value that is already a lane id of one of the invite's projects is
 * kept; a legacy language tag is converted where it names exactly one lane.
 *
 * A multi-project link shares one lane list, so each value is resolved
 * against every project the token covers and the ids are unioned — the
 * accept path then picks out the ones belonging to the project being joined.
 * A value that names two lanes in any of those projects, or no lane in any
 * of them, is refused: the caller says which lane they meant, we never guess.
 */
export type InviteLaneScopeResolution =
  | { ok: true; laneIds: string[] }
  | { ok: false; ambiguous: string[]; unmatched: string[] }

export async function resolveInviteLaneScopes(
  env: Pick<Env, "AQUILLA_PG">,
  projectIds: readonly string[],
  lanes: readonly string[],
): Promise<InviteLaneScopeResolution> {
  if (lanes.length === 0) return { ok: true, laneIds: [] }
  const byProject = await loadTargetLaneIdentitiesForProjects(env.AQUILLA_PG, projectIds)
  // No lane rows anywhere to resolve against — a project whose lanes table
  // has not been populated yet. Store what the caller sent, exactly as this
  // did before lane ids; the AQU-1616 backfill converts it with the rest.
  const anyLanes = projectIds.some((projectId) => (byProject.get(projectId) ?? []).length > 0)
  if (!anyLanes) return { ok: true, laneIds: [...lanes] }
  const laneIds: string[] = []
  const seen = new Set<string>()
  const ambiguous: string[] = []
  const unmatched: string[] = []
  for (const value of lanes) {
    let matchedSomewhere = false
    let ambiguousSomewhere = false
    for (const projectId of projectIds) {
      const resolved = resolveLaneScopeValue(value, byProject.get(projectId) ?? [])
      if (resolved.ok) {
        matchedSomewhere = true
        if (!seen.has(resolved.laneId)) {
          seen.add(resolved.laneId)
          laneIds.push(resolved.laneId)
        }
      } else if (resolved.reason === "ambiguous") {
        ambiguousSomewhere = true
      }
    }
    if (ambiguousSomewhere) ambiguous.push(value)
    else if (!matchedSomewhere) unmatched.push(value)
  }
  if (ambiguous.length > 0 || unmatched.length > 0) return { ok: false, ambiguous, unmatched }
  return { ok: true, laneIds }
}
