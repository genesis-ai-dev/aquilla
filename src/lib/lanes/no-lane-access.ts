/**
 * AQU-2358 — "no lanes" is an answer, not a missing one.
 *
 * Below Maintainer a member reads a target lane only through a
 * `project_member_lane_roles` grant, and the lane choice made on an add or an
 * invite is what writes those grants. Two answers were expressible before this
 * ticket: "every current lane" (stored as NO lane scope rows, which the
 * planner reads as every lane) and "these lanes" (one scope row each). An
 * empty list was not an answer at all — the server refused it
 * (`lane_choice_required`) — so a lead who wanted to let someone see that a
 * project exists, and nothing of its translation, had no way to say it.
 *
 * "No lanes" cannot be stored as zero scope rows, because that is already how
 * "every current lane" is stored, and it is what `grantNewLaneStmt` (AQU-1781)
 * reads as "this member sees every lane, so grant them the new one too". So it
 * is stored as ONE reserved scope value that names no lane:
 *
 *   project_member_scopes  → one `kind='lane'` row holding {@link NO_LANE_SCOPE}
 *   project_invites        → `scope_lanes` = `["__no_lanes__"]`
 *
 * Every rule that reads lane scopes then already does the right thing with it:
 * {@link planLaneGrants} writes no grant rows (it short-circuits on the
 * sentinel), `laneScopeAdmitsTag` admits no lane, the member inspector reports
 * a deliberately restricted member rather than an unscoped one, and
 * `grantNewLaneStmt` skips anyone holding a lane scope, so a lane created later
 * is not granted either.
 *
 * An invite minted BEFORE this ticket carries `scope_lanes = NULL`, which still
 * means "every lane that existed when it is accepted". Nothing re-reads those
 * rows, so an unused old link keeps the behavior it was created with.
 */

/**
 * The reserved lane-scope value that means "no lanes". Not a lane id, not a
 * language tag, and not accepted from callers inside a list of real lanes —
 * `resolveExplicitLaneChoice` refuses the mix rather than guessing.
 */
export const NO_LANE_SCOPE = "__no_lanes__"

/** Whether one stored or requested lane-scope value is the sentinel. */
export function isNoLaneScope(value: string): boolean {
  return value === NO_LANE_SCOPE
}

/**
 * Whether a lane-scope list says "no lanes". An EMPTY list does not: that is
 * the legacy "every current lane" shape, and reading it as "none" would strip
 * lanes from every member and unused invite that predates this ticket.
 */
export function grantsNoLaneScopes(values: readonly string[]): boolean {
  return values.some(isNoLaneScope)
}

/**
 * The lane-scope list to store for a chosen set of lane ids. An empty choice
 * becomes the sentinel, so "no lanes" survives a later role change: a re-add
 * that names no lanes re-plans grants from the stored scopes, and zero stored
 * scopes would re-plan to every lane.
 */
export function laneScopesForChoice(laneIds: readonly string[]): string[] {
  return laneIds.length === 0 ? [NO_LANE_SCOPE] : [...laneIds]
}
