import { readProjectLanes, type ProjectLane } from "../e2e/helpers/frontier-api"

/**
 * The lane fields a seeded `target.cell.*` payload carries, as the SPA's
 * emitters stamp them (src/lib/sync/events-emit.ts): the lane row's frozen
 * `legacy_tag` as `targetLang`, and its id as `laneId`.
 *
 * A target write that names no lane asks for the default `''` lane, which a
 * project created today does not have: every lane carries a real tag, such as
 * its language (AQU-1594 / AQU-1612). The sync-worker then cannot resolve the
 * cell's lane, and the seed is rejected (AQU-1899).
 */
export interface TargetLaneRef {
  targetLang: string
  laneId: string
}

/** The project's first live target lane, as payload fields. Throws when it has none. */
export function primaryTargetLane(lanes: readonly ProjectLane[]): TargetLaneRef {
  const lane = lanes.find((row) => row.role === "target" && !row.archivedAt)
  if (!lane) throw new Error("The project has no live target lane to seed translations on")
  return { targetLang: lane.legacyTag ?? "", laneId: lane.id }
}

/** Read the project's lane rows and pick the lane seeded translations go on. */
export async function readTargetLane(jwt: string, projectId: string): Promise<TargetLaneRef> {
  return primaryTargetLane(await readProjectLanes(jwt, projectId))
}
