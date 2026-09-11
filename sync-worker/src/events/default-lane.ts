// AQU-1240 — the replay-shim resolver.
//
// Eliminating the implicit '' default lane means a lane-less target event has
// to resolve to the REAL lane tag the project's default lane was named. This
// reads that tag from default_lane_migration (0091), the permanent per-project
// record populated by the backfill (slice 5).
//
// `laneOfEvent(kind, payload, projectDefaultLane)` consumes the value returned
// here. See docs/superpowers/specs/2026-09-09-eliminate-default-lane-design.md
// §2.1 (source of the tag), §2.3 (the table), §2.5 (why the shim, and its
// eventual throw-on-missing hardening), §6 slice 3.

import type { AquillaDb } from '../../../db/shim/postgres'

/**
 * The project's resolved default-lane tag, or null when the project has no
 * default_lane_migration row (i.e. the mapping table is unpopulated, which is
 * the state on this dev branch until the backfill runs). A null result makes
 * laneOfEvent fall back to '' — byte-identical to pre-1240 behavior — which is
 * exactly what keeps landing the shim wiring safe before the enable step.
 *
 * resolved_lane is guaranteed non-'' by the table CHECK; the extra guard here
 * is defensive against a hand-edited row.
 *
 * DEFERRED HARDENING (design §2.1, §2.5), intentionally NOT implemented yet:
 *  - fall back to project_settings.target_language (trimmed, non-blank) when no
 *    default_lane_migration row exists, so every live project always resolves;
 *  - THROW instead of returning null when a legacy-shaped event meets a project
 *    with neither a mapping nor a usable target_language ("cannot determine the
 *    lane" is only safely answered by refusing).
 * Both are switched on with slices 4/5; enabling them now would flip projection
 * behavior (and could throw) for every project while the table is still empty.
 *
 * Callers should memoize this per request the way RequestCache.projectSettings
 * does — it is a stable per-project value for the life of a request/replay.
 */
export async function resolveDefaultLane(
  db: AquillaDb,
  projectId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT resolved_lane FROM default_lane_migration WHERE project_id = ?')
    .bind(projectId)
    .first<{ resolved_lane: string }>()
  const tag = row?.resolved_lane
  return typeof tag === 'string' && tag !== '' ? tag : null
}
