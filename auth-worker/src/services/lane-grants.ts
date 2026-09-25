// AQU-1389 — the lane-permission extraction point, owned by AQU-1352.
//
// WHY THIS MODULE EXISTS
//
// PR #719 (AQU-1240/AQU-730) landed the lane MODEL (first-class lanes, stable
// lane ids, content lane_id columns) and, alongside it, the first slice of a
// lane PERMISSION system: the `project_member_lane_roles` table (migration
// 0091) and an unconditional read of that table inside the sync-token mint.
//
// Those are two different rollouts. The lane-model cutover must be able to
// ship — and be rolled back — without touching who can access a lane, and the
// token producer must not acquire a hard dependency on a permission table
// whose backfill has deliberately not run yet (see migration 0091's header:
// "DELIBERATELY NO BACKFILL HERE"). An unconditional read makes every sync
// token mint — and therefore every read, edit, assignment and project
// creation that needs one — depend on that table existing and answering.
//
// So the grant read lives here, behind a fail-closed rollout flag that is OFF
// by default:
//
//   * flag off (default)  → no query is issued at all. The token producer has
//                           zero dependency on project_member_lane_roles; the
//                           table may be absent, empty, or mid-backfill and
//                           minting is unaffected. The `laneGrants` claim is
//                           omitted, which is exactly what every consumer
//                           already sees today (nothing reads it: sync-worker's
//                           resolveVisibleLanes is still unwired).
//   * flag on             → the existing dual-read behavior, unchanged. A
//                           lookup FAILURE is surfaced, never swallowed, so
//                           enforcement can never fail open once AQU-1352
//                           wires the read wall.
//
// NOT A PERMANENT AUTHORITY. `project_member_lane_roles` must not become an
// eighth source of truth. AQU-1352 collapses every grant source into
// `access_grants` behind one resolver; this module is the seam that the
// migration replaces, and the flag is the activation gate for that rollout —
// not for the lane-model cutover.
//
// Design record: docs/superpowers/specs/2026-09-10-lane-permissions-and-read-wall-design.md

import type { Env } from "../types"

/** Additive per-lane grant as carried on the sync token. */
export type LaneGrant = { lane: string; level: number }

/**
 * A lane-grant lookup FAILED. Callers must answer with a transient 5xx, never
 * a permission 403 — mirrors RoleLookupError in project-permissions.ts
 * (AQU-996): a DB blip must not be reported to the SPA outbox as a permanent
 * denial, and must not silently degrade to "no grants" once the read wall is
 * enforcing.
 */
export class LaneGrantLookupError extends Error {
  constructor(cause?: unknown) {
    super("lane grant lookup failed")
    this.name = "LaneGrantLookupError"
    this.cause = cause
  }
}

/**
 * Fail-closed rollout gate. Only the exact string "true" enables the read —
 * same convention as LEGACY_USER_MIGRATION_ENABLED. Unset/absent (the
 * default everywhere, including every deployed environment today) means the
 * lane-grant table is not consulted.
 */
export function laneGrantsEnabled(env: Pick<Env, "LANE_GRANTS_ENABLED">): boolean {
  return String(env.LANE_GRANTS_ENABLED).toLowerCase() === "true"
}

/**
 * Load a member's additive lane grants for the sync-token claim.
 *
 * Returns [] — with NO query issued — while the rollout flag is off, so the
 * token producer never depends on the grant table. When enabled, reads the
 * grants ordered by lane and throws LaneGrantLookupError if the read fails.
 */
export async function loadLaneGrants(
  env: Pick<Env, "AQUILLA_PG" | "LANE_GRANTS_ENABLED">,
  projectId: string,
  userId: number,
): Promise<LaneGrant[]> {
  if (!laneGrantsEnabled(env)) return []

  try {
    const rows = await env.AQUILLA_PG.prepare(
      "SELECT lane, role_level FROM project_member_lane_roles WHERE project_id = ? AND user_id = ? ORDER BY lane",
    )
      .bind(projectId, userId)
      .all<{ lane: string; role_level: number }>()
    return (rows.results ?? []).map((r) => ({ lane: r.lane, level: r.role_level }))
  } catch (err) {
    throw new LaneGrantLookupError(err)
  }
}
